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

// Resolve conda tool paths at startup
const condirPrefix = process.env.CONDA_PREFIX || "/opt/conda/envs/taxalin";
const matUtilsPath = fs.existsSync(`${condirPrefix}/bin/matUtils`)
  ? `${condirPrefix}/bin/matUtils`
  : "matUtils";
const pythonPath = fs.existsSync(`${condirPrefix}/bin/python`)
  ? `${condirPrefix}/bin/python`
  : "python";

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

// Track pipeline output files for dynamic reloading and export
let pipelineOutputFile = null;
let pipelineInputPb = null;

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
var originalLineages = new Map();

function snapshotLineages() {
  originalLineages.clear();
  if (!processedData || !processedData.nodes) return;
  processedData.nodes.forEach(node => {
    const lineage = node.meta_annotation_1 || node.meta_lineage ||
      node.meta_pango_lineage || node.meta_Nextclade_pango ||
      node.meta_pangolin_lineage || node.lineage || '';
    originalLineages.set(node.node_id, lineage);
  });
  console.log(`Snapshotted lineages for ${originalLineages.size} nodes`);
}

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
    const isGzipped = inputFile.endsWith(".pb.gz");
    const basename = isGzipped
      ? path.basename(inputFile, ".pb.gz")
      : path.basename(inputFile, ".pb");
    const outputDir = path.dirname(inputFile);

    // Decompress .pb.gz to .pb if needed
    let actualInput = inputFile;
    if (isGzipped) {
      const zlib = require("zlib");
      actualInput = path.join(outputDir, `${basename}.pb`);
      const compressed = fs.readFileSync(inputFile);
      fs.writeFileSync(actualInput, zlib.gunzipSync(compressed));
    }

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
      "-i", actualInput,
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
      const pythonCmd = pythonPath;
      
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
      const pythonCmd = pythonPath;
      
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

    // Stage 3: Generate TSV with matUtils summary
    const tsvOutput = path.join(outputDir, `${basename}.autolin.tsv`);
    sendEvent("stage", { stage: "summary" });
    sendEvent("log", { message: "Generating sample lineage assignments (TSV)..." });

    await new Promise((resolve, reject) => {
      const matUtilsCmd = matUtilsPath;
      const matUtils = spawn(matUtilsCmd, ["summary", "-i", autolinPb, "-C", tsvOutput], {
        cwd: "/",
        env: { ...process.env }
      });

      matUtils.stderr.on("data", (data) => {
        const lines = data.toString().split("\n").filter(l => l.trim());
        lines.forEach(line => sendEvent("log", { message: line }));
      });

      matUtils.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          // Non-fatal: TSV is optional
          sendEvent("log", { message: `matUtils summary exited with code ${code}, TSV not generated` });
          resolve();
        }
      });

      matUtils.on("error", (err) => {
        sendEvent("log", { message: `matUtils not available: ${err.message}` });
        resolve();
      });
    });

    if (fs.existsSync(tsvOutput)) {
      sendEvent("log", { message: "TSV generated successfully" });
    }

    // Compress .pb to .pb.gz for download
    const zlib = require("zlib");
    const autolinPbGz = autolinPb + ".gz";
    if (fs.existsSync(autolinPb)) {
      fs.writeFileSync(autolinPbGz, zlib.gzipSync(fs.readFileSync(autolinPb)));
    }

    // Store output files for the reload and export endpoints
    pipelineOutputFile = jsonlOutput;
    pipelineInputPb = actualInput;

    // Build list of available downloads
    const downloads = [];
    if (fs.existsSync(jsonlOutput)) downloads.push({ name: `${basename}.autolin.jsonl.gz`, path: jsonlOutput });
    if (fs.existsSync(autolinPbGz)) downloads.push({ name: `${basename}.autolin.pb.gz`, path: autolinPbGz });
    if (fs.existsSync(tsvOutput)) downloads.push({ name: `${basename}.autolin.tsv`, path: tsvOutput });

    sendEvent("complete", {
      outputFile: jsonlOutput,
      downloads: downloads,
      message: "Pipeline completed successfully"
    });

    res.end();

  } catch (error) {
    console.error("Pipeline error:", error);
    sendEvent("error", { message: error.message });
    res.end();
  }
});

// Download a pipeline output file
app.get("/download", function (req, res) {
  const filePath = req.query.path;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  // Only allow downloading from the temp upload directory
  if (!filePath.startsWith(os.tmpdir())) {
    return res.status(403).json({ error: "Access denied" });
  }
  res.download(filePath);
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

      snapshotLineages();
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

  // Helper function to find parent lineage by walking up the tree
  // Returns the first ancestor clade node with a different label
  const findParentLineage = (nodeId, currentCladeLabel) => {
    let currentNode = nodeLookup[nodeId];
    while (currentNode && currentNode.parent_id && currentNode.parent_id !== currentNode.node_id) {
      const parentNode = nodeLookup[currentNode.parent_id];
      if (parentNode && parentNode.clades && parentNode.clades.pango) {
        const parentClade = parentNode.clades.pango;
        if (parentClade !== currentCladeLabel) {
          return parentClade;
        }
      }
      currentNode = parentNode;
    }
    return null;
  };

  // Second pass: for each clade node, calculate counts and find parent from tree
  // Include ALL clade nodes (even those without direct tips — they may be
  // intermediate lineages needed for a correct hierarchy)
  for (const [cladeLabel, cladeNode] of cladeNodeMap.entries()) {
    const descendants = getAllDescendants(cladeNode.node_id);

    const descendantLineageSet = new Set();
    let totalTips = 0;
    let directTips = 0;

    descendants.forEach(descId => {
      const descNode = nodeLookup[descId];
      if (descNode && descNode.is_tip) {
        totalTips++;
        if (descNode[field] && descNode[field] !== '') {
          if (descNode[field] !== cladeLabel) {
            descendantLineageSet.add(descNode[field]);
          } else {
            directTips++;
          }
        }
      }
    });

    const parentLineage = findParentLineage(cladeNode.node_id, cladeLabel);

    lineageHierarchy.set(cladeLabel, {
      value: cladeLabel,
      count: totalTips,
      descendantLineages: descendantLineageSet.size,
      descendantLeaves: totalTips,
      parent: parentLineage
    });
  }

  console.log(`DEBUG: Found ${totalNodes} total nodes`);
  console.log(`DEBUG: Found ${cladeNodeMap.size} clade nodes`);
  console.log(`DEBUG: Built hierarchy for ${lineageHierarchy.size} lineages`);

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

  const { lineageName, field } = req.body;

  if (!lineageName || !field) {
    return res.status(400).send({
      error: "Missing required parameters: lineageName, field"
    });
  }

  // Determine the parent lineage from the tree structure
  // Find the clade node for this lineage, then walk up to find the parent clade
  let parentLineage = null;
  const nodeLookup = {};
  processedData.nodes.forEach(node => { nodeLookup[node.node_id] = node; });

  // Find this lineage's clade node
  let cladeNode = null;
  for (const node of processedData.nodes) {
    if (!node.is_tip && node.clades && node.clades.pango === lineageName) {
      cladeNode = node;
      break;
    }
  }

  if (cladeNode) {
    // Walk up tree to find parent clade (including the root node)
    let current = nodeLookup[cladeNode.parent_id];
    while (current) {
      if (current.clades && current.clades.pango && current.clades.pango !== lineageName) {
        parentLineage = current.clades.pango;
        break;
      }
      if (current.parent_id === current.node_id) break; // reached root
      current = nodeLookup[current.parent_id];
    }
  }

  if (!parentLineage) {
    return res.status(400).send({
      error: `Cannot merge "${lineageName}" - no parent lineage found in tree`
    });
  }

  console.log(`Merging ${lineageName} (and sub-lineages) into ${parentLineage}`);

  // Merge: reassign tips with this lineage or any sub-lineage to the parent
  const isLineageToMerge = (nodeLineage) => {
    return nodeLineage === lineageName || nodeLineage.startsWith(lineageName + '.');
  };

  let mergedCount = 0;
  const affectedLineages = new Set();

  processedData.nodes.forEach(node => {
    if (node.is_tip && node[field] && isLineageToMerge(node[field])) {
      affectedLineages.add(node[field]);
      node[field] = parentLineage;
      mergedCount++;
    }
  });

  // Rebuild clade labels to reflect the new tip assignments
  rebuildCladeLabels(field);

  console.log(`Merged ${mergedCount} nodes into ${parentLineage} in ${Date.now() - start_time}ms`);

  res.send({
    success: true,
    mergedCount,
    parentLineage,
    affectedLineages: Array.from(affectedLineages),
    message: `Merged ${mergedCount} samples into ${parentLineage}`
  });
});

// Rebuild clade labels by finding the MRCA of each lineage's tips
function rebuildCladeLabels(field) {
  console.log('Rebuilding clade labels...');
  const start = Date.now();

  const nodeLookup = {};
  processedData.nodes.forEach(node => { nodeLookup[node.node_id] = node; });

  // Clear existing clade labels
  processedData.nodes.forEach(node => {
    if (!node.is_tip && node.clades) {
      delete node.clades.pango;
    }
  });

  // Collect tips per lineage
  const lineageTips = {};
  processedData.nodes.forEach(node => {
    if (node.is_tip && node[field]) {
      const lin = node[field];
      if (!lineageTips[lin]) lineageTips[lin] = [];
      lineageTips[lin].push(node.node_id);
    }
  });

  // Compute depth for each node (used to find deepest common ancestor)
  const depth = {};
  processedData.nodes.forEach(node => {
    if (depth[node.node_id] !== undefined) return;
    const stack = [];
    let cur = node;
    while (depth[cur.node_id] === undefined) {
      stack.push(cur.node_id);
      if (cur.parent_id === cur.node_id) { depth[cur.node_id] = 0; stack.pop(); break; }
      cur = nodeLookup[cur.parent_id];
    }
    let d = depth[cur.node_id];
    while (stack.length > 0) {
      d++;
      depth[stack.pop()] = d;
    }
  });

  // LCA of two nodes: walk the deeper one up, then walk both up together
  const lca = (a, b) => {
    let na = a, nb = b;
    while (depth[na] > depth[nb]) na = nodeLookup[na].parent_id;
    while (depth[nb] > depth[na]) nb = nodeLookup[nb].parent_id;
    while (na !== nb) {
      na = nodeLookup[na].parent_id;
      nb = nodeLookup[nb].parent_id;
    }
    return na;
  };

  // For each lineage, find MRCA and set clade label
  let cladeCount = 0;
  for (const [lineage, tips] of Object.entries(lineageTips)) {
    if (tips.length === 0) continue;
    let mrca = tips[0];
    for (let i = 1; i < tips.length; i++) {
      mrca = lca(mrca, tips[i]);
    }
    const mrcaNode = nodeLookup[mrca];
    if (mrcaNode && !mrcaNode.is_tip) {
      if (!mrcaNode.clades) mrcaNode.clades = {};
      mrcaNode.clades.pango = lineage;
      cladeCount++;
    }
  }

  console.log(`Rebuilt ${cladeCount} clade labels in ${Date.now() - start}ms`);
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

  // Build a set of all lineages that are children of the edited lineage
  // (so we don't overwrite more-specific annotations)
  const childLineages = new Set();
  processedData.nodes.forEach(node => {
    if (!node.is_tip && node.clades && node.clades.pango) {
      const clade = node.clades.pango;
      if (clade !== lineageName && clade.startsWith(lineageName + '.')) {
        childLineages.add(clade);
      }
      // Also check auto. children: auto.lineageName.X is a child
      if (clade.startsWith('auto.' + lineageName + '.')) {
        childLineages.add(clade);
      }
    }
  });
  // Also collect child lineages from tip annotations
  processedData.nodes.forEach(node => {
    if (node.is_tip && node[field]) {
      const ann = node[field];
      if (ann !== lineageName && ann.startsWith(lineageName + '.')) {
        childLineages.add(ann);
      }
      if (ann.startsWith('auto.' + lineageName + '.')) {
        childLineages.add(ann);
      }
    }
  });

  const isChildLineage = (ann) => childLineages.has(ann);

  // Get all nodes that should have this lineage (descendants of root node)
  const targetNodeIds = getDescendants(rootNodeId);

  // Find the parent lineage to reassign displaced tips
  let parentLineage = null;
  let cur = nodeLookup[rootNode.parent_id];
  while (cur) {
    if (cur.clades && cur.clades.pango && cur.clades.pango !== lineageName) {
      parentLineage = cur.clades.pango;
      break;
    }
    if (cur.parent_id === cur.node_id) break; // reached root
    cur = nodeLookup[cur.parent_id];
  }

  let assignedCount = 0;
  let clearedCount = 0;

  processedData.nodes.forEach(node => {
    if (!node.is_tip) return;
    const currentLineage = node[field] || null;

    if (targetNodeIds.has(node.node_id)) {
      // Inside the new subtree: assign this lineage UNLESS the tip has a
      // more-specific child lineage annotation
      if (currentLineage !== lineageName && !isChildLineage(currentLineage)) {
        node[field] = lineageName;
        assignedCount++;
      }
    } else if (currentLineage === lineageName) {
      // Outside the new subtree: reassign to parent lineage
      if (parentLineage) {
        node[field] = parentLineage;
      } else {
        node[field] = '';
      }
      clearedCount++;
    }
  });

  console.log(`Assigned ${lineageName} to ${assignedCount} tips, displaced ${clearedCount} tips`);

  rebuildCladeLabels(field);

  console.log(`Operation completed in ${Date.now() - start_time}ms`);

  res.send({
    success: true,
    assignedCount,
    clearedCount,
    totalAffected: targetNodeIds.size,
    parentLineage,
    message: `Reassigned ${lineageName} to ${assignedCount} nodes under root ${rootNodeId}`
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

    res.write('sample\tlineage\tmodified\n');

    processedData.nodes.forEach(node => {
      if (!node.is_tip) return;

      const name = node.name || node.node_id || '';
      const lineage = node.meta_annotation_1 || node.meta_lineage ||
        node.meta_pango_lineage || node.meta_Nextclade_pango ||
        node.meta_pangolin_lineage || node.lineage || '';
      const orig = originalLineages.get(node.node_id) || '';
      const modified = lineage !== orig ? 1 : 0;

      res.write(`${name}\t${lineage}\t${modified}\n`);
    });

    res.end();
    console.log(`TSV export completed in ${Date.now() - start_time}ms`);

  } catch (error) {
    console.error('Error exporting TSV:', error);
    res.status(500).send({ error: 'Failed to export TSV' });
  }
});

// Export annotated protobuf reflecting current lineage edits
app.get("/export/pb", async function (req, res) {
  console.log("/export/pb - exporting annotated protobuf");

  if (!pipelineInputPb || !fs.existsSync(pipelineInputPb)) {
    return res.status(400).json({ error: "No pipeline protobuf available" });
  }

  try {
    const zlib = require("zlib");
    const outputDir = path.dirname(pipelineInputPb);
    const cladeFile = path.join(outputDir, "export_clades.tsv");
    const exportPb = path.join(outputDir, "export_annotated.pb");

    // Build clade annotation file from current in-memory lineage assignments
    // Format: lineage\tnode_id (for matUtils annotate -c)
    const lines = [];
    processedData.nodes.forEach(node => {
      let lineage = node.meta_annotation_1 || node.meta_lineage || node.meta_pango_lineage ||
        node.meta_Nextclade_pango || node.meta_pangolin_lineage || node.lineage || '';
      if (lineage && !node.is_tip) {
        lines.push(`${lineage}\t${node.name || node.node_id}`);
      }
    });
    fs.writeFileSync(cladeFile, lines.join("\n") + "\n");

    // Run matUtils annotate to apply current assignments to original pb
    await new Promise((resolve, reject) => {
      const matUtilsCmd = matUtilsPath;
      const proc = spawn(matUtilsCmd, [
        "annotate", "-i", pipelineInputPb, "-l", "-c", cladeFile, "-o", exportPb
      ], { cwd: "/", env: { ...process.env } });

      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`matUtils annotate exited with code ${code}`));
      });
      proc.on("error", (err) => reject(err));
    });

    // Gzip and send
    const pbData = fs.readFileSync(exportPb);
    const gzipped = zlib.gzipSync(pbData);

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="exported_tree.pb.gz"');
    res.send(gzipped);

    // Cleanup temp files
    try { fs.unlinkSync(cladeFile); fs.unlinkSync(exportPb); } catch(e) {}

  } catch (error) {
    console.error('Error exporting pb:', error);
    res.status(500).json({ error: 'Failed to export protobuf: ' + error.message });
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
  snapshotLineages();
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
