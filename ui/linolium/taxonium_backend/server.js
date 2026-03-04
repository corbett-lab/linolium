var express = require("express");
var cors = require("cors");
var compression = require("compression");
var queue = require("express-queue");
var app = express();
var fs = require("fs");
const path = require("node:path");
const os = require("node:os");
var https = require("https");
var xml2js = require("xml2js");
var axios = require("axios");
var pako = require("pako");
const URL = require("url").URL;
const ReadableWebToNodeStream = require("readable-web-to-node-stream");
const { execSync, spawn } = require("child_process");
const { Readable } = require("stream");
const multer = require("multer");
var parser = require("stream-json").parser;
var streamValues = require("stream-json/streamers/StreamValues").streamValues;

var importing;
var filtering;
var exporting;

const { program } = require("commander");

program
  .option("--ssl", "use ssl")
  .option("--port <port>", "port", 8000)
  .option("--config_json <config_json>", "config json")
  .option("--config_override <json>", "arbitrary JSON to override config keys")
  .option("--data_url <data url>", "data url")
  .option(
    "--data_file <data file>",
    "local data file, as alternative to data url"
  );

program.parse();

const command_options = program.opts();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "taxonium"));

// Setup multer for file uploads
const uploadDir = path.join(tmpDir, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ 
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 } // 5GB limit
});

// Track pipeline output file for dynamic reloading
let pipelineOutputFile = null;

// Lock to prevent multiple simultaneous data reloads
let reloadInProgress = false;
let reloadPromise = null;

const in_cache = new Set();

const cache_helper = {
  retrieve_from_cache: (key) => {
    console.log("retrieving ", key);
    if (!in_cache.has(key)) {
      console.log("not found");
      return undefined;
    } else {
      // get from tmpDir, parsing the JSON
      console.log("found");
      const retrieved = JSON.parse(fs.readFileSync(path.join(tmpDir, key)));

      return retrieved;
    }
  },
  store_in_cache: (key, value) => {
    console.log("caching ", key);
    // store in tmpDir, serializing the JSON
    fs.writeFileSync(path.join(tmpDir, key), JSON.stringify(value));
    in_cache.add(key);
  },
};

// Allow starting without data for launcher mode
const launcherMode = command_options.data_url === undefined && 
                     command_options.data_file === undefined;

if (launcherMode) {
  console.log("Starting in launcher mode - no data file specified");
  console.log("Upload a .pb file through the UI to begin");
}

import("taxonium_data_handling/importing.js").then((imported) => {
  importing = imported.default;
  console.log("imported importing");
  console.log("importing is ", importing);
});

import("taxonium_data_handling/filtering.js").then((imported) => {
  filtering = imported.default;
  console.log("imported filtering");
});

import("taxonium_data_handling/exporting.js").then((imported) => {
  exporting = imported.default;
  console.log("imported exporting");
});

waitForTheImports = async () => {
  if (importing === undefined || filtering === undefined) {
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (importing !== undefined && filtering !== undefined) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });
  }
};

var processedData = null;
var cached_starting_values = null;

let options;

app.use(cors());
app.use(compression());
app.use(express.json()); // Parse JSON request bodies

app.use(queue({ activeLimit: 500000, queuedLimit: 500000 }));

const logStatusMessage = (status_obj) => {
  console.log("status", status_obj);
  if (process && process.send) {
    process.send(status_obj);
  }
};

app.get("/", function (req, res) {
  res.send("Hello World, Taxonium is here!");
});

// File upload endpoint
app.post("/upload", upload.single("file"), function (req, res) {
  console.log("/upload - receiving file");
  
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const originalName = req.file.originalname;
  const newPath = path.join(uploadDir, originalName);
  
  // Rename file to preserve original extension
  fs.renameSync(req.file.path, newPath);
  
  console.log(`File uploaded: ${originalName} -> ${newPath}`);
  
  res.json({
    success: true,
    filename: originalName,
    path: newPath,
    size: req.file.size
  });
});

// Pipeline execution endpoint - runs autolin propose + conversion
app.post("/run-autolin", async function (req, res) {
  console.log("/run-autolin - starting pipeline");
  
  const { inputFile, params } = req.body;
  
  if (!inputFile) {
    return res.status(400).json({ error: "No input file specified" });
  }

  // Set headers for streaming response
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");

  const sendEvent = (type, data) => {
    res.write(JSON.stringify({ type, ...data }) + "\n");
  };

  try {
    const basename = path.basename(inputFile, ".pb");
    const outputDir = path.dirname(inputFile);
    const autolinPb = path.join(outputDir, `${basename}.autolin.pb`);
    const jsonlOutput = path.join(outputDir, `${basename}.autolin.jsonl.gz`);

    // Determine autolin directory (relative to this script or in /app for Docker)
    const autolinDir = fs.existsSync("/app/autolin") 
      ? "/app/autolin" 
      : path.resolve(__dirname, "../../autolin");

    sendEvent("stage", { stage: "proposing" });
    sendEvent("log", { message: `Input: ${inputFile}` });
    sendEvent("log", { message: `Output: ${autolinPb}` });

    // Build command arguments for propose_sublineages.py
    const proposeArgs = [
      "propose_sublineages.py",
      "-i", inputFile,
      "-o", autolinPb,
      "-m", String(params?.minsamples || 10),
      "-t", String(params?.distinction || 1),
      "-u", String(params?.cutoff || 0.95),
      "-f", String(params?.floor || 0)
    ];

    if (params?.recursive) proposeArgs.push("-r");
    if (params?.verbose) proposeArgs.push("-v");
    if (params?.clear) proposeArgs.push("-c");

    sendEvent("log", { message: `Running: python ${proposeArgs.join(" ")}` });

    // Run propose_sublineages.py
    await new Promise((resolve, reject) => {
      const pythonCmd = process.env.CONDA_PREFIX 
        ? `${process.env.CONDA_PREFIX}/bin/python`
        : "python";
      
      const propose = spawn(pythonCmd, proposeArgs, {
        cwd: autolinDir,
        env: { ...process.env }
      });

      propose.stdout.on("data", (data) => {
        const lines = data.toString().split("\n").filter(l => l.trim());
        lines.forEach(line => sendEvent("log", { message: line }));
      });

      propose.stderr.on("data", (data) => {
        const lines = data.toString().split("\n").filter(l => l.trim());
        lines.forEach(line => sendEvent("log", { message: line }));
      });

      propose.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`propose_sublineages.py exited with code ${code}`));
        }
      });

      propose.on("error", (err) => {
        reject(new Error(`Failed to start propose_sublineages.py: ${err.message}`));
      });
    });

    sendEvent("log", { message: "propose_sublineages.py completed successfully" });

    // Stage 2: Convert to Taxonium format
    sendEvent("stage", { stage: "converting" });
    sendEvent("log", { message: "Converting to Taxonium format..." });

    const convertArgs = [
      "convert_autolinpb_totax.py",
      "-a", autolinPb
    ];

    sendEvent("log", { message: `Running: python ${convertArgs.join(" ")}` });

    await new Promise((resolve, reject) => {
      const pythonCmd = process.env.CONDA_PREFIX 
        ? `${process.env.CONDA_PREFIX}/bin/python`
        : "python";
      
      const convert = spawn(pythonCmd, convertArgs, {
        cwd: autolinDir,
        env: { ...process.env }
      });

      convert.stdout.on("data", (data) => {
        const lines = data.toString().split("\n").filter(l => l.trim());
        lines.forEach(line => sendEvent("log", { message: line }));
      });

      convert.stderr.on("data", (data) => {
        const lines = data.toString().split("\n").filter(l => l.trim());
        lines.forEach(line => sendEvent("log", { message: line }));
      });

      convert.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`convert_autolinpb_totax.py exited with code ${code}`));
        }
      });

      convert.on("error", (err) => {
        reject(new Error(`Failed to start convert_autolinpb_totax.py: ${err.message}`));
      });
    });

    sendEvent("log", { message: "Conversion completed successfully" });

    // Store the output file for the reload endpoint
    pipelineOutputFile = jsonlOutput;

    sendEvent("complete", { 
      outputFile: jsonlOutput,
      message: "Pipeline completed successfully"
    });

    res.end();

  } catch (error) {
    console.error("Pipeline error:", error);
    sendEvent("error", { message: error.message });
    res.end();
  }
});

// Reload data from a new file (called after pipeline completes)
app.post("/reload-data", async function (req, res) {
  console.log("/reload-data - reloading data from pipeline output");

  const { dataFile } = req.body;
  const fileToLoad = dataFile || pipelineOutputFile;

  if (!fileToLoad) {
    return res.status(400).json({ error: "No data file specified" });
  }

  if (!fs.existsSync(fileToLoad)) {
    return res.status(404).json({ error: `File not found: ${fileToLoad}` });
  }

  // If a reload is already in progress, wait for it
  if (reloadInProgress && reloadPromise) {
    console.log("Reload already in progress, waiting...");
    try {
      await reloadPromise;
      return res.json({ success: true, nodes: processedData.nodes.length, cached: true });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // Start new reload
  reloadInProgress = true;
  
  reloadPromise = (async () => {
    try {
      await waitForTheImports();

      const stream = fs.createReadStream(fileToLoad);
      const supplied_object = {
        stream: stream,
        status: "stream_supplied",
        filename: fileToLoad,
      };

      processedData = await importing.processJsonl(
        supplied_object,
        logStatusMessage,
        ReadableWebToNodeStream.ReadableWebToNodeStream,
        parser,
        streamValues,
        Buffer
      );

      if (config.no_file) {
        importing.generateConfig(config, processedData);
      }

      processedData.genes = Array.from(
        new Set(processedData.mutations.map((mutation) => mutation.gene))
      );

      cached_starting_values = filtering.getNodes(
        processedData.nodes,
        processedData.y_positions,
        processedData.overallMinY,
        processedData.overallMaxY,
        processedData.overallMinX,
        processedData.overallMaxX,
        "x_dist",
        config.useHydratedMutations,
        processedData.mutations
      );

      console.log("Data reloaded successfully");
      return { success: true, nodes: processedData.nodes.length };
    } finally {
      reloadInProgress = false;
    }
  })();

  try {
    const result = await reloadPromise;
    res.json(result);
  } catch (error) {
    console.error("Reload error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/search", function (req, res) {
  const start_time = Date.now();
  console.log("/search");
  const json = req.query.json;
  const spec = JSON.parse(JSON.parse(json));
  console.log(spec);

  const minYbound =
    req.query.min_y !== undefined ? req.query.min_y : processedData.overallMinY;
  const maxYbound =
    req.query.max_y !== undefined ? req.query.max_y : processedData.overallMaxY;
  const minXbound =
    req.query.min_x !== undefined ? req.query.min_x : processedData.overallMinX;
  const maxXbound =
    req.query.max_x !== undefined ? req.query.max_x : processedData.overallMaxX;

  const forSingleSearch = {
    data: processedData.nodes,
    spec,
    min_y: minYbound,
    max_y: maxYbound,
    min_x: minXbound,
    max_x: maxXbound,
    y_positions: processedData.y_positions,
    mutations: processedData.mutations,
    node_to_mut: processedData.node_to_mut,
    xType: req.query.xType,
    cache_helper: cache_helper,
  };

  const result = filtering.singleSearch(forSingleSearch);
  res.send(result);
  console.log(
    "Found " +
      result.data.length +
      " results in " +
      (Date.now() - start_time) +
      "ms"
  );
  console.log("Result type was " + result.type);
});

let path_for_config = command_options.config_json;
let config;

// Check if config passed in a valid URL
const stringIsAValidUrl = (s) => {
  try {
    new URL(s);
    return true;
  } catch (err) {
    return false;
  }
};

if (stringIsAValidUrl(path_for_config)) {
  console.log("CONFIG_JSON detected as a URL. Downloading config.");
  // Delete any trailing /
  path_for_config = path_for_config.endsWith("/")
    ? path_for_config.slice(0, -1)
    : path_for_config;

  // Download file through wget
  execSync(`wget -c ${path_for_config}`);

  // Extract file name
  const splitURL = path_for_config.split("/");
  const fileName = splitURL[splitURL.length - 1];

  path_for_config = fileName;

  console.log("Config name set to", path_for_config);
}

// check if path exists
if (path_for_config && fs.existsSync(path_for_config)) {
  config = JSON.parse(fs.readFileSync(path_for_config));
} else {
  config = { title: "", source: "", no_file: true };
}

if (command_options.config_override) {
  try {
    // Parse the override JSON string provided on the command line.
    const overrides = JSON.parse(command_options.config_override);
    // Merge key-by-key into the base config.
    config = { ...config, ...overrides };
    console.log("Configuration after override:", config);
  } catch (err) {
    console.error("Error parsing --config_override JSON:", err);
    process.exit(1);
  }
}

app.get("/config", function (req, res) {
  config.num_nodes = processedData.nodes.length;
  config.initial_x =
    (processedData.overallMinX + processedData.overallMaxX) / 2;
  config.initial_y =
    (processedData.overallMinY + processedData.overallMaxY) / 2;
  config.initial_zoom = -2;
  config.genes = processedData.genes;
  config = { ...config, ...processedData.overwrite_config };
  config.rootMutations = config.useHydratedMutations
    ? []
    : processedData.rootMutations;
  config.rootId = processedData.rootId;

  res.send(config);
});

app.get("/lineages", function (req, res) {
  const start_time = Date.now();
  console.log("/lineages - extracting all lineage data from full dataset");
  console.log("DEBUG: /lineages endpoint called");

  // Get the field name from query parameter, default to 'meta_annotation_1'
  const field = req.query.field || 'meta_annotation_1';
  console.log("DEBUG: field =", field);

  // Build node lookup and parent-child relationships for tree traversal FIRST
  const nodeLookup = {};
  const children = {};
  let totalNodes = 0;
  let nodesWithLineage = 0;

  processedData.nodes.forEach(node => {
    totalNodes++;
    nodeLookup[node.node_id] = node;
    if (node[field] && node[field] !== '') {
      nodesWithLineage++;
    }
    if (node.parent_id && node.parent_id !== node.node_id) {
      if (!children[node.parent_id]) {
        children[node.parent_id] = [];
      }
      children[node.parent_id].push(node.node_id);
    }
  });

  console.log(`DEBUG: Built parent-child relationships for ${Object.keys(children).length} parents`);

  // Function to get all descendant node IDs recursively
  const getAllDescendants = (nodeId) => {
    const descendants = [];
    const toVisit = children[nodeId] || [];

    while (toVisit.length > 0) {
      const currentNodeId = toVisit.pop();
      descendants.push(currentNodeId);

      // Add children of current node to visit queue
      if (children[currentNodeId]) {
        toVisit.push(...children[currentNodeId]);
      }
    }

    return descendants;
  };

  // Build lineage hierarchy directly from clade labels in the tree
  const cladeNodeMap = new Map(); // Map clade label -> clade node
  const lineageHierarchy = new Map(); // Map lineage -> {count, descendants, parent, etc.}

  // First pass: collect all clade nodes
  for (const node of processedData.nodes) {
    if (node.clades && node.clades.pango && !node.is_tip) {
      cladeNodeMap.set(node.clades.pango, node);
    }
  }

  // Before processing clades, build a set of all lineages that actually exist in tips
  const actualExistingLineages = new Set();
  processedData.nodes.forEach(node => {
    if (node.is_tip && node[field] && node[field] !== '') {
      actualExistingLineages.add(node[field]);
    }
  });

  // Helper function to find parent lineage by walking up the tree
  const findParentLineage = (nodeId, currentCladeLabel) => {
    let currentNode = nodeLookup[nodeId];
    while (currentNode && currentNode.parent_id && currentNode.parent_id !== currentNode.node_id) {
      const parentNode = nodeLookup[currentNode.parent_id];
      if (parentNode && parentNode.clades && parentNode.clades.pango) {
        const parentClade = parentNode.clades.pango;
        // Only return if it's a different clade and actually exists
        if (parentClade !== currentCladeLabel && actualExistingLineages.has(parentClade)) {
          return parentClade;
        }
      }
      currentNode = parentNode;
    }
    return null; // No parent lineage found (this is a root lineage)
  };

  // Second pass: for each clade, calculate its direct count and descendant info
  // Count ALL descendant tips under this clade, including those with different lineage annotations
  for (const [cladeLabel, cladeNode] of cladeNodeMap.entries()) {
    // Skip clades that don't correspond to existing lineages (i.e., merged away)
    if (!actualExistingLineages.has(cladeLabel)) {
      continue;
    }

    const descendants = getAllDescendants(cladeNode.node_id);

    // Count all descendant leaves and unique lineages
    const descendantLineageSet = new Set();
    let totalTips = 0;  // ALL tips under this clade
    let directTips = 0; // Tips with this exact lineage annotation

    descendants.forEach(descId => {
      const descNode = nodeLookup[descId];
      if (descNode && descNode.is_tip) {
        totalTips++;  // Count all tips
        if (descNode[field] && descNode[field] !== '') {
          // Track what lineages are under this clade
          if (descNode[field] !== cladeLabel) {
            descendantLineageSet.add(descNode[field]);
          } else {
            directTips++;  // Tips directly assigned to this lineage
          }
        }
      }
    });

    // Find the parent lineage by walking up the tree
    const parentLineage = findParentLineage(cladeNode.node_id, cladeLabel);

    lineageHierarchy.set(cladeLabel, {
      value: cladeLabel,
      count: totalTips, // Total count is ALL descendant tips under this clade
      descendantLineages: descendantLineageSet.size,
      descendantLeaves: totalTips,
      parent: parentLineage // Parent lineage from tree structure
    });
  }

  console.log(`DEBUG: Found ${totalNodes} total nodes`);
  console.log(`DEBUG: Found ${cladeNodeMap.size} clade nodes`);
  console.log(`DEBUG: Built hierarchy for ${lineageHierarchy.size} lineages`);

  // Add missing intermediate lineages by analyzing the hierarchy
  const allLineageNames = Array.from(lineageHierarchy.keys());
  const intermediateLineages = new Set();
  
  // Find all intermediate lineage names that should exist
  allLineageNames.forEach(lineageName => {
    const parts = lineageName.split('.');
    // Only create intermediate lineages that have at least 2 parts and aren't too top-level
    for (let i = 2; i < parts.length; i++) {  // Start from 2 to avoid creating "auto"
      const intermediateName = parts.slice(0, i).join('.');
      // Only create if it looks like a real lineage (has enough specificity)
      if (!lineageHierarchy.has(intermediateName) && parts.length > 3) {
        intermediateLineages.add(intermediateName);
      }
    }
  });

  // Calculate counts for intermediate lineages by aggregating from descendants
  intermediateLineages.forEach(intermediateName => {
    const descendantLineageSet = new Set();
    let descendantLeaves = 0;
    let directCount = 0;

    // Find all lineages that are descendants of this intermediate lineage
    allLineageNames.forEach(lineageName => {
      if (lineageName.startsWith(intermediateName + '.')) {
        const descendantData = lineageHierarchy.get(lineageName);
        if (descendantData) {
          descendantLeaves += descendantData.descendantLeaves;
          // Only count this lineage as a descendant if it actually exists in the current tip data
          if (actualExistingLineages.has(lineageName)) {
            descendantLineageSet.add(lineageName);
          }
        }
      }
    });

    // Only add the intermediate lineage if it has actual descendants or direct tips
    // Check if any tips are directly assigned to this intermediate lineage
    let directTipCount = 0;
    processedData.nodes.forEach(node => {
      if (node.is_tip && node[field] === intermediateName) {
        directTipCount++;
      }
    });

    // Only include this intermediate lineage if it has direct tips or valid descendants
    if (directTipCount > 0 || descendantLineageSet.size > 0) {
      lineageHierarchy.set(intermediateName, {
        value: intermediateName,
        count: descendantLeaves + directTipCount,
        descendantLineages: descendantLineageSet.size,
        descendantLeaves: descendantLeaves + directTipCount
      });
    }
  });

  console.log(`DEBUG: Added ${intermediateLineages.size} intermediate lineages`);
  console.log(`DEBUG: Total lineages now: ${lineageHierarchy.size}`);

  // Filter out redundant auto.X lineages where X also exists
  // These represent the same clade - autolin creates auto.X as an intermediate
  // but if X exists as an established lineage, we should use X
  const allExistingLineages = new Set(lineageHierarchy.keys());
  const toRemove = [];
  
  for (const [lineageName, lineageData] of lineageHierarchy.entries()) {
    if (lineageName.startsWith('auto.')) {
      const baseName = lineageName.substring(5);
      if (allExistingLineages.has(baseName)) {
        // The non-auto version exists, remove the auto version
        toRemove.push(lineageName);
        console.log(`DEBUG: Filtering out ${lineageName} because ${baseName} exists`);
      }
    }
  }
  
  toRemove.forEach(name => lineageHierarchy.delete(name));
  console.log(`DEBUG: Removed ${toRemove.length} redundant auto lineages`);

  // Convert to array format from our clade-based hierarchy
  const lineageArray = Array.from(lineageHierarchy.values());

  // Sort by count descending
  lineageArray.sort((a, b) => b.count - a.count);

  const response = {
    lineages: lineageArray,
    field: field,
    totalNodes: totalNodes,
    nodesWithLineage: nodesWithLineage,
    uniqueLineages: lineageArray.length
  };

  console.log(`Found ${lineageArray.length} unique lineages in ${Date.now() - start_time}ms`);
  res.send(response);
});

app.get("/mutations/", function (req, res) {
  // Set headers for SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Function to send SSE
  function sendSSE(data) {
    res.write(`data: ${data}\n\n`);
  }

  // Send mutations in chunks of 100000
  const chunkSize = 10000;
  let index = 0;

  function sendNextChunk() {
    const chunk = processedData.mutations.slice(index, index + chunkSize);
    if (chunk.length > 0) {
      sendSSE(JSON.stringify(chunk));
      index += chunkSize;
      // Schedule the next chunk
      setImmediate(sendNextChunk);
    } else {
      // All mutations sent, end the stream
      sendSSE("END");
      res.end();
    }
  }

  // Start sending chunks
  sendNextChunk();

  // Handle client disconnect
  req.on("close", () => {
    // No need to destroy a stream, just stop the process
    index = processedData.mutations.length; // This will stop sendNextChunk on next iteration
  });
});

app.get("/nodes/", function (req, res) {
  const start_time = Date.now();
  let min_y =
    req.query.min_y !== undefined ? req.query.min_y : processedData.overallMinY;
  let max_y =
    req.query.max_y !== undefined ? req.query.max_y : processedData.overallMaxY;
  let min_x =
    req.query.min_x !== undefined ? req.query.min_x : processedData.overallMinX;
  let max_x =
    req.query.max_x !== undefined ? req.query.max_x : processedData.overallMaxX;
  if (min_y < processedData.overallMinY) {
    min_y = processedData.overallMinY;
  }
  if (max_y > processedData.overallMaxY) {
    max_y = processedData.overallMaxY;
  }
  if (min_x < processedData.overallMinX) {
    min_x = processedData.overallMinX;
  }
  if (max_x > processedData.overallMaxX) {
    max_x = processedData.overallMaxX;
  }
  let result;

  if (
    min_y === processedData.overallMinY &&
    max_y === processedData.overallMaxY &&
    min_x === processedData.overallMinX &&
    max_x === processedData.overallMaxX &&
    req.query.xType === "x_dist"
  ) {
    result = cached_starting_values;

    console.log("Using cached values");
  } else {
    result = filtering.getNodes(
      processedData.nodes,
      processedData.y_positions,
      min_y,
      max_y,
      min_x,
      max_x,
      req.query.xType,
      config.useHydratedMutations,
      processedData.mutations
    );
  }
  console.log("Ready to send after " + (Date.now() - start_time) + "ms.");

  // This will be sent as json
  res.send({ nodes: result });
  console.log(
    "Request took " +
      (Date.now() - start_time) +
      "ms, and output " +
      result.length +
      " nodes."
  );
});

// POST endpoint to merge lineages - combines child lineages into parent
app.post("/merge-lineage", function (req, res) {
  const start_time = Date.now();
  console.log("/merge-lineage - merging lineage assignments");

  const { lineageName, parentLineage, field } = req.body;

  if (!lineageName || !parentLineage || !field) {
    return res.status(400).send({
      error: "Missing required parameters: lineageName, parentLineage, field"
    });
  }

  console.log(`Merging ${lineageName} and sublineages into ${parentLineage} for field ${field}`);

  // Function to check if a lineage matches or is a sublineage
  const isLineageToMerge = (nodeLineage) => {
    return nodeLineage === lineageName || nodeLineage.startsWith(lineageName + '.');
  };

  let mergedCount = 0;
  let affectedLineages = new Set();

  // Update all nodes in the dataset
  if (processedData && processedData.nodes) {
    processedData.nodes.forEach(node => {
      let currentLineage = null;

      // Get current lineage from the specified field or fallback fields
      if (field && node[field]) {
        currentLineage = node[field];
      } else if (node.lineage) {
        currentLineage = node.lineage;
      } else if (node.meta_pangolin_lineage) {
        currentLineage = node.meta_pangolin_lineage;
      } else if (node.meta && node.meta[field]) {
        currentLineage = node.meta[field];
      }

      // If this node has a lineage we want to merge, reassign it
      if (currentLineage && isLineageToMerge(currentLineage)) {
        affectedLineages.add(currentLineage);

        // Update the lineage field
        if (field && node.hasOwnProperty(field)) {
          node[field] = parentLineage;
        } else if (node.lineage) {
          node.lineage = parentLineage;
        } else if (node.meta_pangolin_lineage) {
          node.meta_pangolin_lineage = parentLineage;
        } else if (node.meta && node.meta[field]) {
          node.meta[field] = parentLineage;
        }

        mergedCount++;
      }
    });
  }

  console.log(`Merged ${mergedCount} nodes from lineages: ${Array.from(affectedLineages).join(', ')}`);
  console.log(`Operation completed in ${Date.now() - start_time}ms`);

  res.send({
    success: true,
    mergedCount,
    affectedLineages: Array.from(affectedLineages),
    message: `Successfully merged ${mergedCount} samples into ${parentLineage}`
  });
});

// Function to rebuild clade labels for internal nodes after lineage changes
function rebuildCladeLabels(field) {
  console.log('Starting clade label rebuild...');
  
  // Clear existing clade labels
  processedData.nodes.forEach(node => {
    if (!node.is_tip && node.clades) {
      delete node.clades.pango;
    }
  });

  // Build child relationships for traversal
  const children = {};
  processedData.nodes.forEach(node => {
    if (node.parent_id && node.parent_id !== node.node_id) {
      if (!children[node.parent_id]) {
        children[node.parent_id] = [];
      }
      children[node.parent_id].push(node.node_id);
    }
  });

  // Create lookup for faster access
  const nodeLookup = {};
  processedData.nodes.forEach(node => {
    nodeLookup[node.node_id] = node;
  });

  // Function to get the most specific common lineage for descendants of a node
  function getMostSpecificCommonLineage(nodeId) {
    const node = nodeLookup[nodeId];
    if (!node) return null;

    // If it's a tip, return its lineage
    if (node.is_tip) {
      let lineage = null;
      if (field && node[field]) {
        lineage = node[field];
      } else if (node.lineage) {
        lineage = node.lineage;
      } else if (node.meta_pangolin_lineage) {
        lineage = node.meta_pangolin_lineage;
      } else if (node.meta && node.meta[field]) {
        lineage = node.meta[field];
      }
      return lineage || null;
    }

    // For internal nodes, get lineages of all descendant tips
    const descendantLineages = new Set();
    
    function collectDescendantLineages(currentNodeId) {
      const currentNode = nodeLookup[currentNodeId];
      if (!currentNode) return;

      if (currentNode.is_tip) {
        let lineage = null;
        if (field && currentNode[field]) {
          lineage = currentNode[field];
        } else if (currentNode.lineage) {
          lineage = currentNode.lineage;
        } else if (currentNode.meta_pangolin_lineage) {
          lineage = currentNode.meta_pangolin_lineage;
        } else if (currentNode.meta && currentNode.meta[field]) {
          lineage = currentNode.meta[field];
        }
        if (lineage) {
          descendantLineages.add(lineage);
        }
      } else {
        // Recurse to children
        if (children[currentNodeId]) {
          children[currentNodeId].forEach(childId => {
            collectDescendantLineages(childId);
          });
        }
      }
    }

    collectDescendantLineages(nodeId);
    
    if (descendantLineages.size === 0) return null;
    if (descendantLineages.size === 1) {
      // All descendants have the same lineage
      return Array.from(descendantLineages)[0];
    }

    // Multiple lineages - find most specific common ancestor lineage
    const lineageArray = Array.from(descendantLineages);
    let commonParts = lineageArray[0].split('.');
    
    for (let i = 1; i < lineageArray.length; i++) {
      const parts = lineageArray[i].split('.');
      const newCommon = [];
      
      for (let j = 0; j < Math.min(commonParts.length, parts.length); j++) {
        if (commonParts[j] === parts[j]) {
          newCommon.push(commonParts[j]);
        } else {
          break;
        }
      }
      
      commonParts = newCommon;
      if (commonParts.length === 0) break;
    }

    return commonParts.length > 0 ? commonParts.join('.') : null;
  }

  // Assign clade labels to internal nodes
  let cladeCount = 0;
  processedData.nodes.forEach(node => {
    if (!node.is_tip) {
      const commonLineage = getMostSpecificCommonLineage(node.node_id);
      if (commonLineage) {
        if (!node.clades) {
          node.clades = {};
        }
        node.clades.pango = commonLineage;
        cladeCount++;
      }
    }
  });

  console.log(`Rebuilt clade labels: ${cladeCount} internal nodes updated`);
}

// POST endpoint to edit lineage root assignments based on selected tree node
app.post("/edit-lineage-root", function (req, res) {
  const start_time = Date.now();
  console.log("/edit-lineage-root - reassigning lineage based on tree structure");

  const { lineageName, rootNodeId, field } = req.body;

  if (!lineageName || !rootNodeId || !field) {
    return res.status(400).send({
      error: "Missing required parameters: lineageName, rootNodeId, field"
    });
  }

  console.log(`Reassigning ${lineageName} to start from node ${rootNodeId} for field ${field}`);

  // Find the root node (handle both string and number IDs)
  const rootNodeIdNum = parseInt(rootNodeId, 10);
  const rootNode = processedData.nodes.find(node =>
    node.node_id === rootNodeId || node.node_id === rootNodeIdNum
  );
  if (!rootNode) {
    return res.status(404).send({
      error: `Root node ${rootNodeId} not found`
    });
  }

  // Build a lookup for faster parent/child relationships
  const nodeLookup = {};
  const children = {};
  processedData.nodes.forEach(node => {
    nodeLookup[node.node_id] = node;
    if (node.parent_id && node.parent_id !== node.node_id) {
      if (!children[node.parent_id]) {
        children[node.parent_id] = [];
      }
      children[node.parent_id].push(node.node_id);
    }
  });

  // Function to get all descendant nodes of a given node
  const getDescendants = (nodeId) => {
    const descendants = new Set();
    const queue = [nodeId];

    while (queue.length > 0) {
      const currentId = queue.shift();
      descendants.add(currentId);

      if (children[currentId]) {
        children[currentId].forEach(childId => {
          if (!descendants.has(childId)) {
            queue.push(childId);
          }
        });
      }
    }

    return descendants;
  };

  // Get all nodes that should have this lineage (descendants of root node)
  const targetNodeIds = getDescendants(rootNodeId);

  let assignedCount = 0;
  let clearedCount = 0;

  // Update all nodes in the dataset
  processedData.nodes.forEach(node => {
    let currentLineage = null;

    // Get current lineage
    if (field && node[field]) {
      currentLineage = node[field];
    } else if (node.lineage) {
      currentLineage = node.lineage;
    } else if (node.meta_pangolin_lineage) {
      currentLineage = node.meta_pangolin_lineage;
    } else if (node.meta && node.meta[field]) {
      currentLineage = node.meta[field];
    }

    if (targetNodeIds.has(node.node_id)) {
      // This node should have the lineage
      if (currentLineage !== lineageName) {
        // Assign the lineage
        if (field && (node.hasOwnProperty(field) || !node.lineage)) {
          node[field] = lineageName;
        } else if (node.lineage) {
          node.lineage = lineageName;
        } else if (node.meta_pangolin_lineage) {
          node.meta_pangolin_lineage = lineageName;
        } else {
          if (!node.meta) node.meta = {};
          node.meta[field] = lineageName;
        }
        assignedCount++;
      }
    } else if (currentLineage === lineageName) {
      // This node should NOT have the lineage anymore, clear it
      if (field && node[field] === lineageName) {
        delete node[field];
      } else if (node.lineage === lineageName) {
        delete node.lineage;
      } else if (node.meta_pangolin_lineage === lineageName) {
        delete node.meta_pangolin_lineage;
      } else if (node.meta && node.meta[field] === lineageName) {
        delete node.meta[field];
      }
      clearedCount++;
    }
  });

  console.log(`Assigned ${lineageName} to ${assignedCount} nodes, cleared from ${clearedCount} nodes`);
  
  // Rebuild clade labels for internal nodes after lineage changes
  console.log('Rebuilding clade labels after lineage edit...');
  rebuildCladeLabels(field);
  
  console.log(`Operation completed in ${Date.now() - start_time}ms`);

  res.send({
    success: true,
    assignedCount,
    clearedCount,
    totalAffected: targetNodeIds.size,
    message: `Successfully reassigned ${lineageName} to ${assignedCount} nodes under root ${rootNodeId}`
  });
});

function startListening() {
  if (command_options.ssl) {
    options = {
      key: fs.readFileSync(
        "/etc/letsencrypt/live/api.taxonium.org/privkey.pem"
      ),
      ca: fs.readFileSync("/etc/letsencrypt/live/api.taxonium.org/chain.pem"),
      cert: fs.readFileSync(
        "/etc/letsencrypt/live/api.taxonium.org/fullchain.pem"
      ),
    };
    https.createServer(options, app).listen(command_options.port, "0.0.0.0");
    console.log("SSL on port " + command_options.port);
  } else {
    app.listen(command_options.port, "0.0.0.0");
    console.log("Non SSL on port " + command_options.port);
  }
}

async function getGenBankAuthors(genbank_accession) {
  const genbank_xml_url =
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=" +
    genbank_accession +
    "&rettype=gb&retmode=xml";
  const genbank_xml = await axios.get(genbank_xml_url);
  const genbank_xml_json = await xml2js.parseStringPromise(genbank_xml.data);

  let authors =
    genbank_xml_json["GBSet"]["GBSeq"][0]["GBSeq_references"][0][
      "GBReference"
    ][0]["GBReference_authors"][0]["GBAuthor"];
  authors = authors.map((x) => {
    const [last, first] = x.split(",");
    return first + " " + last;
  });
  return authors;

  //['GBSeq_xrefs'][0]['GBXref'])
}

app.get("/node_details/", async (req, res) => {
  const start_time = Date.now();
  const query_id = req.query.id;
  const node = processedData.nodes[query_id];
  const node_mutations = processedData.node_to_mut[query_id].map((mutation) => {
    return processedData.mutations[mutation];
  });

  const detailed_node = { ...node, mutations: node_mutations };

  if (
    config.enable_genbank_acknowledgement &&
    detailed_node.meta_genbank_accession
  ) {
    const genbank_accession = detailed_node.meta_genbank_accession;
    let authors;
    try {
      authors = await getGenBankAuthors(genbank_accession);
    } catch (e) {
      console.log("Error getting authors", e);
    }
    if (authors) {
      detailed_node.acknowledgements = { authors: authors.join(", ") };
    }
  }

  res.send(detailed_node);
  console.log(
    "Request took " + (Date.now() - start_time) + "ms, and output " + node
  );
});

app.get("/tip_atts", async (req, res) => {
  const start_time = Date.now();
  const node_id = req.query.id;
  const att = req.query.att;
  const atts = filtering.getTipAtts(processedData.nodes, node_id, att);
  res.send(atts);
  console.log(
    "Request took " + (Date.now() - start_time) + "ms, and output " + atts
  );
});

// match /nextstrain_json/12345
app.get("/nextstrain_json/:root_id", async (req, res) => {
  const root_id = parseInt(req.params.root_id);
  const json = await exporting.getNextstrainSubtreeJson(
    root_id,
    processedData.nodes,
    config,
    processedData.mutations
  );
  res.setHeader(
    "Content-Disposition",
    "attachment; " + "filename=" + root_id + ".nextstrain.json"
  );
  res.send(json);
});

// Export full tree as Taxonium JSONL format
app.get("/export/jsonl", function (req, res) {
  const start_time = Date.now();
  console.log("/export/jsonl - exporting full tree in Taxonium JSONL format");

  try {
    // Set response headers for file download
    res.setHeader('Content-Type', 'application/jsonl');
    res.setHeader('Content-Disposition', 'attachment; filename="exported_tree.jsonl"');
    
    // Create header object with current tree state
    const header = {
      total_nodes: processedData.nodes.length,
      mutations: processedData.mutations || [],
      overallMinX: processedData.overallMinX,
      overallMaxX: processedData.overallMaxX,
      overallMinY: processedData.overallMinY,
      overallMaxY: processedData.overallMaxY,
      y_positions: processedData.y_positions || [],
      rootMutations: processedData.rootMutations || [],
      rootId: processedData.rootId,
      title: config.title || "Exported Taxonium Tree",
      source: config.source || "Taxonium Export",
      export_timestamp: new Date().toISOString(),
      exported_from: "taxonium_backend"
    };

    // Write header as first line
    res.write(JSON.stringify(header) + '\n');

    // Write each node as a separate line
    processedData.nodes.forEach(node => {
      // Create node object in Taxonium format
      const nodeObj = {
        node_id: node.node_id,
        parent_id: node.parent_id,
        name: node.name || "",
        x_dist: node.x_dist,
        y: node.y,
        mutations: processedData.node_to_mut[node.node_id] || [],
        is_tip: node.is_tip || false,
        num_tips: node.num_tips || 0
      };

      // Add x_time if it exists
      if (node.x_time !== undefined) {
        nodeObj.x_time = node.x_time;
      }

      // Add all metadata fields (meta_*)
      Object.keys(node).forEach(key => {
        if (key.startsWith('meta_')) {
          nodeObj[key] = node[key];
        }
      });

      res.write(JSON.stringify(nodeObj) + '\n');
    });

    res.end();
    console.log(`JSONL export completed in ${Date.now() - start_time}ms`);

  } catch (error) {
    console.error('Error exporting JSONL:', error);
    res.status(500).send({ error: 'Failed to export JSONL' });
  }
});

// Export metadata as TSV format
app.get("/export/metadata", function (req, res) {
  const start_time = Date.now();
  console.log("/export/metadata - exporting metadata in TSV format");

  try {
    // Set response headers for file download
    res.setHeader('Content-Type', 'text/tab-separated-values');
    res.setHeader('Content-Disposition', 'attachment; filename="exported_metadata.tsv"');

    // Create header row - just node_id and lineage
    res.write('node_id\tlineage\n');

    // Write data rows with just node_id and lineage
    processedData.nodes.forEach(node => {
      const nodeId = node.node_id || '';
      // Look for lineage in various possible metadata fields
      let lineage = '';
      
      // Check common lineage field names
      if (node.meta_lineage) {
        lineage = node.meta_lineage;
      } else if (node.meta_pango_lineage) {
        lineage = node.meta_pango_lineage;
      } else if (node.meta_Nextclade_pango) {
        lineage = node.meta_Nextclade_pango;
      } else if (node.meta_pangolin_lineage) {
        lineage = node.meta_pangolin_lineage;
      } else if (node.lineage) {
        lineage = node.lineage;
      } else {
        // If no lineage found, use empty string
        lineage = '';
      }

      // Handle values that might contain tabs or newlines
      const lineageStr = String(lineage);
      const cleanLineage = lineageStr.includes('\t') || lineageStr.includes('\n') || lineageStr.includes('\r') 
        ? `"${lineageStr.replace(/"/g, '""')}"` 
        : lineageStr;

      res.write(`${nodeId}\t${cleanLineage}\n`);
    });

    res.end();
    console.log(`TSV export completed in ${Date.now() - start_time}ms`);

  } catch (error) {
    console.error('Error exporting TSV:', error);
    res.status(500).send({ error: 'Failed to export TSV' });
  }
});

const loadData = async () => {
  await waitForTheImports();
  
  // In launcher mode, skip loading data - wait for user to upload
  if (launcherMode) {
    console.log("Launcher mode: Waiting for data upload");
    // Initialize empty processedData structure
    processedData = {
      nodes: [],
      mutations: [],
      y_positions: [],
      overallMinX: 0,
      overallMaxX: 0,
      overallMinY: 0,
      overallMaxY: 0,
      node_to_mut: {},
      genes: [],
      rootMutations: [],
      rootId: null
    };
    cached_starting_values = [];
    
    setTimeout(() => {
      console.log("Starting to listen (launcher mode)");
      startListening();
      logStatusMessage({
        status: "launcher_ready",
      });
    }, 10);
    return;
  }
  
  let supplied_object;
  if (command_options.data_file) {
    local_file = command_options.data_file;
    //  create a stream from the file
    const stream = fs.createReadStream(local_file);

    supplied_object = {
      stream: stream,
      status: "stream_supplied",
      filename: local_file,
    };
  } else {
    url = command_options.data_url;

    supplied_object = { status: "url_supplied", filename: url };
  }

  processedData = await importing.processJsonl(
    supplied_object,
    logStatusMessage,
    ReadableWebToNodeStream.ReadableWebToNodeStream,
    parser,
    streamValues,
    Buffer
  );

  logStatusMessage({
    status: "finalising",
  });

  if (config.no_file) {
    importing.generateConfig(config, processedData);
  }

  processedData.genes = new Set(
    processedData.mutations.map((mutation) => mutation.gene)
  );
  // as array
  processedData.genes = Array.from(processedData.genes);
  console.log("Loaded data");

  result = filtering.getNodes(
    processedData.nodes,
    processedData.y_positions,
    processedData.overallMinY,
    processedData.overallMaxY,
    processedData.overallMinX,
    processedData.overallMaxX,
    "x_dist",
    config.useHydratedMutations,
    processedData.mutations
  );

  cached_starting_values = result;
  console.log("Saved cached starting vals");
  // set a timeout to start listening

  setTimeout(() => {
    console.log("Starting to listen");
    startListening();
    logStatusMessage({
      status: "loaded",
    });
  }, 10);
};
loadData();
