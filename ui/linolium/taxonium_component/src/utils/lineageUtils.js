/**
 * Utility functions for handling Pango lineage data
 */

/**
 * Check if a category name appears to be a Pango lineage
 * @param {string} name - The category name to check
 * @returns {boolean} True if the name follows Pango lineage format
 */
export const isPangoLineage = (name) => {
  if (!name) return false;
  
  // Enhanced pattern to handle various lineage formats:
  // - Single letters: A, B, C
  // - Multi-letter roots: BA, AY, XBB
  // - With numeric parts: B.1, AY.4, XBB.1.5
  // - Recombinants: X, XA, XBB.1.5
  return /^[A-Za-z]+(\.\d+)*$/.test(name);
};

/**
 * Parses a Pango lineage name to determine its hierarchical structure
 * 
 * Autolin naming convention:
 * - auto.X.Y is a PROPOSED sublineage of X (the Y is a serial number)
 * - auto.lineage4.8.1.1 is the first proposed child of lineage4.8.1
 * - auto.lineage4.8.1.1.1 is the first proposed child of auto.lineage4.8.1.1
 * 
 * The parent lookup works by checking if the auto. version of the parent exists:
 * - auto.lineage4.8.1.1 → try auto.lineage4.8.1, if not exists → lineage4.8.1
 * - auto.lineage4.8.1.1.1 → auto.lineage4.8.1.1 (exists in data)
 * 
 * @param {string} lineageName - The Pango lineage name (e.g., "B.1.1.7" or "auto.lineage4.8.1.1")
 * @param {Set} allLineages - Optional set of all lineage names to check for parent existence
 * @returns {object} Object with parts array and parent lineage name
 */
export const parseLineageName = (lineageName, allLineages = null) => {
  if (!lineageName) return { parts: [], parent: null };
  
  // Handle 'auto.' prefix
  if (lineageName.startsWith('auto.')) {
    const baseName = lineageName.substring(5); // Remove 'auto.' prefix
    const baseParts = baseName.split('.');
    
    // auto.X.Y.Z -> parent could be auto.X.Y (if it exists) or X.Y (the base lineage)
    // auto.lineage4.8.1.1 -> parent is lineage4.8.1 (base) or auto.lineage4.8.1 if it exists
    // auto.lineage4.8.1.1.1 -> parent is auto.lineage4.8.1.1
    if (baseParts.length > 1) {
      const parentBaseName = baseParts.slice(0, -1).join('.');
      const autoParent = 'auto.' + parentBaseName;
      
      // If we have a list of all lineages, check if auto parent exists
      // Otherwise, prefer the auto parent if the base has enough parts to suggest it's auto-generated
      if (allLineages) {
        // Check if auto.parent exists in the data
        if (allLineages.has(autoParent)) {
          return { 
            parts: ['auto', ...baseParts], 
            parent: autoParent
          };
        }
      } else {
        // Heuristic: if baseName has 3+ parts after the root lineage name,
        // the parent is likely also an auto lineage
        // e.g., auto.lineage4.8.1.1.1 -> auto.lineage4.8.1.1
        // But auto.lineage4.8.1 -> lineage4.8 (first level of auto)
        // Count dots in baseName to determine depth
        const dotCount = (baseName.match(/\./g) || []).length;
        // If there are 3+ parts (e.g., lineage4.8.1.1 has 3 dots), parent is likely auto
        if (dotCount >= 3) {
          return { 
            parts: ['auto', ...baseParts], 
            parent: autoParent
          };
        }
      }
      
      // Default: parent is the non-auto base lineage
      return { 
        parts: ['auto', ...baseParts], 
        parent: parentBaseName
      };
    } else {
      // auto.X with no dots - this is a root-level proposed lineage
      return { 
        parts: ['auto', baseName], 
        parent: null
      };
    }
  }
  
  // Handle multi-letter root lineages (AY, BA, XBB, etc.)
  let parts;
  let parent = null;
  
  // Special handling for multi-letter root lineages
  if (/^[A-Z]{2,}($|\.)/.test(lineageName)) {
    const dotIndex = lineageName.indexOf('.');
    if (dotIndex > 0) {
      // Multi-letter root with children (e.g., "AY.4")
      const rootPart = lineageName.substring(0, dotIndex);
      const numericParts = lineageName.substring(dotIndex + 1).split('.');
      parts = [rootPart, ...numericParts];
      
      // For "AY.4", parent is "AY"
      parent = rootPart;
      
      // For "AY.4.2", parent is "AY.4"
      if (numericParts.length > 1) {
        parent = rootPart + '.' + numericParts.slice(0, numericParts.length - 1).join('.');
      }
    } else {
      // Just the root lineage (e.g., "AY")
      parts = [lineageName];
      parent = null;
    }
  } else {
    // Standard lineage handling (e.g., "B.1.1.7" or "lineage2.2.1")
    parts = lineageName.split('.');
    parent = parts.length > 1 
      ? parts.slice(0, parts.length - 1).join('.') 
      : null;
  }
  
  return { parts, parent };
};

/**
 * Normalizes lineage names for hierarchical coloring by mapping normal lineages into auto hierarchy
 * @param {string} name - The lineage name to normalize
 * @returns {string} The normalized lineage name
 */
const normalizeLineageForColoring = (name) => {
  // Strip "auto." prefix so auto.lineage4.8.13 → lineage4.8.13
  // This places auto-proposed lineages as children of their parent lineage
  // in the color hierarchy tree
  if (name.startsWith('auto.')) {
    return name.slice(5);
  }
  return name;
};

/**
 * Organizes lineage data into a hierarchical structure based on Pango naming
 * @param {Array} lineages - Array of lineage objects with value, count, color, and parent properties
 * @param {Object} nodeTypes - Optional object with node type information (internal vs leaf)
 * @returns {Array} Hierarchical structure of lineages
 */
export const organizeLineageHierarchy = (lineages, nodeTypes = null) => {
  if (!lineages || !lineages.length) return [];
  
  // Build a set of all lineage names for quick lookup
  const allNames = new Set(lineages.map(l => l.value).filter(Boolean));
  
  // No filtering needed - the backend already provides the correct lineages
  // Just use lineages directly
  const processedLineages = lineages.map(l => ({ ...l }));
  
  // Create a map for quick access to lineages by name
  const lineageMap = {};
  
  // Build a lookup of lineage data including parent from backend
  const lineageDataMap = {};
  processedLineages.forEach(lineage => {
    if (lineage.value) {
      lineageDataMap[lineage.value] = lineage;
    }
  });
  
  // First pass: Create nodes for all lineages that appear in the data
  processedLineages.forEach(lineage => {
    if (!lineage.value) return;
    
    if (!lineageMap[lineage.value]) {
      // Determine if the count represents leaf nodes, internal nodes, or both
      const isLeafCount = !nodeTypes || !nodeTypes[lineage.value] || nodeTypes[lineage.value] === 'leaf';
      
      lineageMap[lineage.value] = {
        name: lineage.value,
        count: lineage.count,
        originalCount: lineage.count,
        sampleCount: isLeafCount ? lineage.count : 0,
        internalCount: isLeafCount ? 0 : lineage.count,
        descendantLineages: lineage.descendantLineages || 0,
        descendantLeaves: lineage.descendantLeaves || 0,
        color: generatePangoLineageColor(lineage.value, processedLineages),
        children: [],
        isExpanded: false,
        level: getLineageLevel(lineage.value),
        backendParent: lineage.parent || null // Parent from backend tree traversal
      };
    }
  });
  
  // Create a set of all lineage names for parent lookup
  const allLineageNames = new Set(Object.keys(lineageMap));
  
  // Get the parent for a lineage using the backend-provided tree-derived parent
  const getParent = (lineageName) => {
    const node = lineageMap[lineageName];

    // Use backend-provided parent (derived from tree structure)
    if (node && node.backendParent && allLineageNames.has(node.backendParent)) {
      return node.backendParent;
    }

    // No backend parent — this is a root lineage
    return null;
  };
  
  // No intermediate parent creation needed — the backend provides all lineage
  // nodes (including those without direct tips) with tree-derived parents.
  
  // Second pass: Build the hierarchy and accumulate counts
  const rootLineages = [];
  
  // Link children to parents and accumulate counts
  Object.values(lineageMap).forEach(node => {
    const parent = getParent(node.name);
    
    if (!parent) {
      // This is a root-level lineage (e.g., "A", "B", "AY")
      rootLineages.push(node);
    } else if (lineageMap[parent]) {
      // Add as a child to its parent
      lineageMap[parent].children.push(node);
      // Add reference to parent for child nodes to support percentages
      node.parent = lineageMap[parent];
    } else {
      // Parent doesn't exist in our data, add to root
      rootLineages.push(node);
    }
  });
  
  // Third pass: Recursive function to accumulate counts from children
  const accumulateChildCounts = (node) => {
    if (!node.children || node.children.length === 0) {
      // For leaf nodes in the hierarchy, return various counts
      return {
        totalCount: node.originalCount,
        sampleCount: node.sampleCount,
        internalCount: node.internalCount
      };
    }
    
    // Accumulate counts from all children
    let totalChildrenCount = 0;
    let totalSampleCount = node.sampleCount; // Start with this node's own sample count
    let totalInternalCount = node.internalCount; // Start with this node's own internal count
    
    for (const child of node.children) {
      const childCounts = accumulateChildCounts(child);
      totalChildrenCount += childCounts.totalCount;
      totalSampleCount += childCounts.sampleCount;
      totalInternalCount += childCounts.internalCount;
    }
    
    // Update node's counts
    node.count = node.originalCount + totalChildrenCount; // Total count including children
    node.sampleCount = totalSampleCount; // Total sample (leaf) count including children
    node.internalCount = totalInternalCount; // Total internal node count including children
    node.totalTaxa = totalSampleCount + totalInternalCount; // Total taxa (leaves + internal nodes)
    
    return {
      totalCount: node.count,
      sampleCount: totalSampleCount,
      internalCount: totalInternalCount
    };
  };
  
  // Apply count accumulation to all root lineages
  rootLineages.forEach(accumulateChildCounts);
  
  // Sort children by total count (including child counts) descending
  const sortByCount = (a, b) => b.count - a.count;
  
  const sortChildren = (node) => {
    if (node.children && node.children.length > 0) {
      node.children.sort(sortByCount);
      node.children.forEach(sortChildren);
    }
  };
  
  rootLineages.sort(sortByCount);
  rootLineages.forEach(sortChildren);
  
  return rootLineages;
};

/**
 * Get the level of a lineage in the Pango hierarchy
 * @param {string} lineageName - The Pango lineage name (e.g., "B.1.1.7")
 * @returns {number} The hierarchy level (0 for A/B, 1 for A.1/B.1, etc.)
 */
export const getLineageLevel = (lineageName) => {
  if (!lineageName) return 0;
  
  // Handle 'auto.' prefix - auto.X is one level deeper than X
  if (lineageName.startsWith('auto.')) {
    const baseName = lineageName.substring(5);
    return getLineageLevel(baseName) + 1;
  }
  
  // Handle multi-letter root lineages (AY, BA, XBB, etc.)
  if (/^[A-Z]{2,}($|\.)/.test(lineageName)) {
    if (lineageName.indexOf('.') === -1) {
      // Just a root like "AY" or "XBB" - level 0
      return 0;
    } else {
      // Count dots for level beyond the root
      return lineageName.split('.').length - 1;
    }
  }
  
  // Standard processing for regular lineages
  const { parts } = parseLineageName(lineageName);
  return parts.length - 1;
};

/**
 * Check if a lineage is a direct child of another lineage
 * @param {string} childLineage - The potential child lineage (e.g., "B.1.1")
 * @param {string} parentLineage - The potential parent lineage (e.g., "B.1")
 * @returns {boolean} True if childLineage is a direct child of parentLineage
 */
export const isDirectChild = (childLineage, parentLineage) => {
  if (!childLineage || !parentLineage) return false;
  
  // Special handling for multi-letter lineages
  if (/^[A-Z]{2,}($|\.)/.test(childLineage)) {
    // Get the correct parts using extractLineageRoot
    const { rootLineage: childRoot, nameParts: childParts } = extractLineageRoot(childLineage);
    const { rootLineage: parentRoot, nameParts: parentParts } = extractLineageRoot(parentLineage);
    
    // For multi-letter lineages, the parent must be the same root
    // And child must have exactly one more level
    if (childRoot !== parentRoot) {
      return false;
    }
    
    return childParts.length === parentParts.length + 1 &&
           childParts.slice(0, parentParts.length).join('.') === parentParts.join('.');
  }
  
  // Standard lineage handling
  const childParts = parseLineageName(childLineage).parts;
  const parentParts = parseLineageName(parentLineage).parts;
  
  // Direct child has exactly one more part than parent
  if (childParts.length !== parentParts.length + 1) return false;
  
  // All parent parts must match the beginning of the child parts
  for (let i = 0; i < parentParts.length; i++) {
    if (parentParts[i] !== childParts[i]) return false;
  }
  
  return true;
};



/**
 * Determines the root lineage component for a given Pango lineage name
 * @param {string} lineageName - The Pango lineage name (e.g., "B.1.1.7", "AY.4", "XBB.1.5")
 * @returns {object} Object with rootLineage and nameParts
 */
export const extractLineageRoot = (lineageName) => {
  if (!lineageName) return { rootLineage: null, nameParts: [] };
  
  let rootLineage, nameParts;
  
  // Handle recombinant lineages (X lineages)
  if (lineageName.startsWith('X')) {
    // Recombinants get special treatment
    if (lineageName.length > 1 && lineageName.indexOf('.') > 0) {
      // Something like XA.1 or XBB.1.5
      const dotIndex = lineageName.indexOf('.');
      rootLineage = lineageName.substring(0, dotIndex);
      nameParts = [rootLineage, ...lineageName.substring(dotIndex + 1).split('.')];
    } else if (lineageName.length > 1) {
      // Something like XA, XBB (no dot)
      rootLineage = lineageName;
      nameParts = [rootLineage];
    } else {
      // Just X (unlikely)
      rootLineage = lineageName;
      nameParts = [rootLineage];
    }
  }
  // Handle 2-letter root lineages like BA, BQ, AY, etc.
  else if (/^[A-Z]{2,}($|\.)/.test(lineageName)) {
    // Multi-letter root like BA.2, AY.4, etc.
    const dotIndex = lineageName.indexOf('.');
    if (dotIndex > 0) {
      rootLineage = lineageName.substring(0, dotIndex);
      nameParts = [rootLineage, ...lineageName.substring(dotIndex + 1).split('.')];
    } else {
      // Just BA, BQ, AY, etc. with no dot
      rootLineage = lineageName;
      nameParts = [rootLineage];
    }
  } 
  // Standard single-letter root lineages (A, B)
  else {
    const parts = lineageName.split('.');
    rootLineage = parts[0];
    nameParts = parts;
  }
  
  return { rootLineage, nameParts };
};

// Global cache for hierarchical colors to improve performance
let __hierarchicalColorCache = {};
let __lastLineageDataHash = null;

/**
 * Clear the hierarchical color cache (useful when lineage data changes)
 */
export const clearHierarchicalColorCache = () => {
  __hierarchicalColorCache = {};
  __lastLineageDataHash = null;
};

/**
 * Generates a hierarchical color scheme for lineages using distinct hues and shades
 *
 * Algorithm:
 * 1. Use a set of distinct hues for top-level lineages
 * 2. Split from the root, using a new hue for each major branch
 * 3. When hues are exhausted, use shades of the parent hue for descendant lineages
 * 4. Maintain visual hierarchy through lightness and saturation variations
 *
 * @param {string} lineageName - The lineage name (e.g., "B.1.1.7")
 * @param {object|null} lineageData - Optional lineage data with count info for prevalence-based coloring
 * @returns {Array} RGB color array [r, g, b]
 */
export const generatePangoLineageColor = (lineageName, allLineageData = null) => {
  if (!allLineageData && typeof window !== 'undefined' && (window).__taxoniumLineageData) {
    allLineageData = (window).__taxoniumLineageData;
  }

  if (__hierarchicalColorCache[lineageName]) {
    return __hierarchicalColorCache[lineageName];
  }
  if (!lineageName || typeof lineageName !== 'string') return [180, 180, 180];

  // Curated categorical palette — 10 distinct, colorblind-friendly colors
  // Inspired by Tableau 10 / d3-category10, tuned for dark-on-light tree backgrounds
  const palette = [
    [31, 119, 180],   // blue
    [255, 127, 14],   // orange
    [44, 160, 44],    // green
    [214, 39, 40],    // red
    [148, 103, 189],  // purple
    [140, 86, 75],    // brown
    [227, 119, 194],  // pink
    [23, 190, 207],   // cyan
    [188, 189, 34],   // olive
    [127, 127, 127],  // gray
  ];

  // Lighter tints for cycling when > 10 siblings
  const tint = (rgb, amount) => rgb.map(c => Math.min(255, Math.round(c + (255 - c) * amount)));
  const shade = (rgb, amount) => rgb.map(c => Math.round(c * (1 - amount)));

  const simpleHash = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  };

  const isAuto = lineageName.startsWith('auto.');

  // Non-auto lineages → muted neutral (these are the unassigned parent bucket)
  if (!isAuto) {
    const result = [185, 185, 178];
    __hierarchicalColorCache[lineageName] = result;
    return result;
  }

  // For auto lineages: find the parent lineage and terminal segments
  const stripped = lineageName.slice(5); // remove "auto."
  const parts = stripped.split('.');
  let parentDepth = parts.length - 1; // default: everything but last segment

  if (allLineageData && Array.isArray(allLineageData)) {
    const nonAutoNames = new Set(
      allLineageData.map(item => (item.value || item))
        .filter(n => typeof n === 'string' && !n.startsWith('auto.'))
    );
    let best = 0;
    for (let i = 1; i <= parts.length; i++) {
      if (nonAutoNames.has(parts.slice(0, i).join('.'))) best = i;
    }
    if (best > 0) parentDepth = best;
  }

  const parentPrefix = parts.slice(0, parentDepth).join('.');

  // Find direct auto children of this parent (the main sibling set)
  // e.g., for parent "lineage4.8", find auto.lineage4.8.X (one segment past parent)
  let directSiblings = [];
  if (allLineageData && Array.isArray(allLineageData)) {
    const prefix = 'auto.' + parentPrefix + '.';
    const seen = new Set();
    for (const item of allLineageData) {
      const name = item.value || item;
      if (typeof name === 'string' && name.startsWith(prefix)) {
        // Extract just the first segment past the parent
        const rest = name.slice(prefix.length);
        const firstSeg = rest.split('.')[0];
        if (firstSeg && !seen.has(firstSeg)) {
          seen.add(firstSeg);
          directSiblings.push(firstSeg);
        }
      }
    }
    directSiblings.sort((a, b) => {
      const na = parseInt(a), nb = parseInt(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });
  }

  // Determine which direct sibling this lineage belongs to
  const terminalSegments = parts.slice(parentDepth);
  const directChild = terminalSegments[0] || '0';
  const siblingIndex = directSiblings.indexOf(directChild);
  const idx = siblingIndex >= 0 ? siblingIndex : simpleHash(directChild) % palette.length;

  // Pick base color from palette, cycling with tint/shade shifts if > 10
  const cycle = Math.floor(idx / palette.length);
  let baseColor = palette[idx % palette.length];
  if (cycle === 1) baseColor = tint(baseColor, 0.35);
  else if (cycle === 2) baseColor = shade(baseColor, 0.25);
  else if (cycle > 2) baseColor = tint(baseColor, 0.15 * cycle);

  // Sub-lineages (e.g., auto.lineage4.8.4.1) → lighter tint of their parent auto color
  const subDepth = terminalSegments.length - 1; // 0 for direct children
  let result;
  if (subDepth === 0) {
    result = baseColor;
  } else {
    result = tint(baseColor, Math.min(0.5, subDepth * 0.2));
  }

  __hierarchicalColorCache[lineageName] = result;
  return result;
}; 