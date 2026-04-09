import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Button } from "./Basic";
import { FaCheck, FaChevronRight, FaChevronDown, FaFilter, FaArrowUp, FaEdit, FaSitemap, FaLeaf, FaSearch } from "react-icons/fa";
import { SearchMethod } from "../types/search";
import {
  organizeLineageHierarchy,
  generatePangoLineageColor,
  isPangoLineage,
  isDirectChild,
  parseLineageName,
  extractLineageRoot
} from "../utils/lineageUtils";
import LineageTimeChart from "./LineageTimeChart";
import type { ColorHook } from "../types/color";
import toast from 'react-hot-toast';

interface ExtendedLineageItem {
  value: string;
  count: number;
  color?: number[];
  originalCount?: number;
  sampleCount?: number;
  totalTaxa?: number;
  descendantLineages?: number;
  descendantLeaves?: number;
}

interface LineageToolsProps {
  keyStuff: ExtendedLineageItem[];
  colorHook: ColorHook;
  colorByField: string;
  onCategorySelect: (category: string | null) => void;
  selectedCategory: string | null;
  isPangoLineageField?: boolean;
  toggleSidebar: () => void;
  isVisible: boolean;
  data: any;
  xType: string;
  hoveredKey: string | null;
  setHoveredKey: (key: string | null) => void;
  onMergeLineage?: (lineageName: string) => void;
  onEditLineage?: (lineageName: string) => void;
  editingLineage?: string | null;
  onCancelEdit?: () => void;
  view?: any;
  backend?: any;
  config?: any;
  deckSize?: { width: number; height: number } | null;
  boundsForQueries?: any;
  pipelineDownloads?: { name: string; path: string }[];
  editHistory?: EditHistoryEntry[];
  onUndo?: (editId?: number) => void;
  setHighlightedRoots?: (names: string[] | null) => void;
}

type EditHistoryEntry = {
  id: number;
  action: string;
  lineageName: string;
  parentLineage?: string;
  description: string;
  timestamp: string;
  affectedLineages?: string[];
};

const EditHistoryPanel = ({ editHistory, onUndo, backendUrl }: {
  editHistory: EditHistoryEntry[];
  onUndo?: (editId?: number) => void;
  backendUrl?: string;
}) => {
  const [hoveredUndoId, setHoveredUndoId] = useState<number | null>(null);
  const [conflictSet, setConflictSet] = useState<Set<number>>(new Set());

  // Fetch conflict preview from backend when hovering an undo button
  useEffect(() => {
    if (hoveredUndoId === null || !backendUrl) {
      setConflictSet(new Set());
      return;
    }
    let cancelled = false;
    fetch(`${backendUrl}/undo-preview/${hoveredUndoId}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) setConflictSet(new Set(data.wouldUndo));
      })
      .catch(() => {
        if (!cancelled) setConflictSet(new Set([hoveredUndoId]));
      });
    return () => { cancelled = true; };
  }, [hoveredUndoId, backendUrl]);

  const wouldBeUndone = (id: number) => conflictSet.has(id);

  return (
    <div className="border-t border-gray-200 px-2 py-1.5">
      <div className="flex items-center justify-between mb-1">
        <span style={{ fontSize: '10px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Edit Log
        </span>
        {onUndo && (
          <button
            onClick={() => onUndo()}
            onMouseEnter={() => setHoveredUndoId(editHistory[editHistory.length - 1]?.id)}
            onMouseLeave={() => setHoveredUndoId(null)}
            style={{
              fontSize: '10px',
              padding: '1px 6px',
              borderRadius: '3px',
              border: '1px solid #d1d5db',
              background: '#f9fafb',
              color: '#374151',
              cursor: 'pointer',
            }}
            title="Undo last edit"
          >
            Undo last
          </button>
        )}
      </div>
      <div style={{ maxHeight: '120px', overflowY: 'auto', fontSize: '10px' }}>
        {editHistory.map((entry, index) => {
          const highlighted = wouldBeUndone(entry.id);
          return (
            <div
              key={entry.id}
              className="flex items-center gap-1"
              style={{
                color: highlighted ? '#dc2626' : '#6b7280',
                background: highlighted ? '#fef2f2' : 'transparent',
                lineHeight: 1.3,
                padding: '2px 3px',
                borderRadius: '2px',
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              <span style={{
                flexShrink: 0,
                width: '14px',
                fontSize: '9px',
                color: highlighted ? '#dc2626' : '#9ca3af',
                textAlign: 'right',
              }}>
                {index + 1}.
              </span>
              <span style={{
                flexShrink: 0,
                width: '13px',
                height: '13px',
                borderRadius: '2px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '8px',
                fontWeight: 600,
                background: highlighted ? '#fecaca' : entry.action === 'merge' ? '#dbeafe' : '#fef3c7',
                color: highlighted ? '#dc2626' : entry.action === 'merge' ? '#2563eb' : '#d97706',
              }}>
                {entry.action === 'merge' ? 'M' : 'E'}
              </span>
              <span
                className="truncate flex-grow"
                title={entry.description}
                style={{ textDecoration: highlighted ? 'line-through' : 'none' }}
              >
                {entry.lineageName}
                {entry.action === 'merge' && entry.parentLineage && (
                  <>
                    <span style={{ margin: '0 4px', color: highlighted ? '#dc2626' : '#9ca3af' }}>→</span>
                    {entry.parentLineage}
                  </>
                )}
              </span>
              {onUndo && (
                <button
                  onClick={(e) => { e.stopPropagation(); onUndo(entry.id); }}
                  onMouseEnter={() => setHoveredUndoId(entry.id)}
                  onMouseLeave={() => setHoveredUndoId(null)}
                  style={{
                    flexShrink: 0,
                    fontSize: '9px',
                    color: highlighted ? '#dc2626' : '#9ca3af',
                    cursor: 'pointer',
                    background: 'none',
                    border: 'none',
                    padding: '0 2px',
                  }}
                  title={
                    conflictSet.size > 1 && conflictSet.has(entry.id)
                      ? `Undo this + ${conflictSet.size - 1} conflicting edit(s)`
                      : 'Undo this edit'
                  }
                >
                  ↩
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Create a deep comparator for memoization to avoid unnecessary re-renders
const arePropsEqual = (prevProps: LineageToolsProps, nextProps: LineageToolsProps) => {
  // Always re-render if visibility changes
  if (prevProps.isVisible !== nextProps.isVisible) return false;

  // Always re-render if selected category changes
  if (prevProps.selectedCategory !== nextProps.selectedCategory) return false;

  // Check if colorByField has changed
  if (prevProps.colorByField !== nextProps.colorByField) return false;

  // For keyStuff, check if the reference has changed
  // This ensures we process new data when it's available
  if (prevProps.keyStuff !== nextProps.keyStuff) return false;

  if (prevProps.pipelineDownloads !== nextProps.pipelineDownloads) return false;
  if (prevProps.editHistory !== nextProps.editHistory) return false;

  // If we get here, props are considered equal
  return true;
};

// Use React.memo with custom comparator to prevent unnecessary re-renders
const LineageTools = React.memo<LineageToolsProps>(({
  keyStuff,
  colorHook,
  colorByField,
  onCategorySelect,
  selectedCategory,
  isPangoLineageField = false,
  toggleSidebar,
  isVisible,
  data,
  xType,
  hoveredKey,
  setHoveredKey,
  onMergeLineage,
  onEditLineage,
  editingLineage,
  onCancelEdit,
  view,
  backend,
  config,
  deckSize,
  boundsForQueries,
  pipelineDownloads,
  editHistory,
  onUndo,
  setHighlightedRoots
}) => {
  const [hierarchyData, setHierarchyData] = useState<any[]>([]);
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const useHierarchicalColors = false; // Default to simple hash-based colors
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const listContainerRef = useRef<HTMLDivElement | null>(null);

  // Scroll the selected lineage into view when it changes
  useEffect(() => {
    if (!selectedCategory || !listContainerRef.current) return;
    // Expand ancestors so the item is rendered before we scroll
    const parts = selectedCategory.split('.');
    const ancestors: Record<string, boolean> = {};
    for (let i = 1; i < parts.length; i++) {
      ancestors[parts.slice(0, i).join('.')] = true;
    }
    if (Object.keys(ancestors).length > 0) {
      setExpandedItems((prev) => ({ ...prev, ...ancestors }));
    }
    // Defer scroll to next frame so any newly expanded items are in the DOM
    const raf = requestAnimationFrame(() => {
      const el = listContainerRef.current?.querySelector<HTMLElement>(
        `[data-lineage-name="${CSS.escape(selectedCategory)}"]`
      );
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedCategory]);

  // Process data with debouncing to prevent rapid updates
  useEffect(() => {
    // Always log when the component receives data
    console.log('=== LINEAGE TOOLS DATA UPDATE ===');
    console.log('keyStuff received:', keyStuff);
    console.log('keyStuff length:', keyStuff ? keyStuff.length : 'null');
    console.log('================================');

    // Skip if no data
    if (!keyStuff) {
      setIsLoading(false);
      return;
    }

    // Set loading state
    setIsLoading(true);

    // Simple debounce to prevent UI blocking
    const timer = setTimeout(() => {
      try {

        if (keyStuff.length > 0) {
          // Build hierarchy data
          const hierarchy = organizeLineageHierarchy(keyStuff);

          // Print lineage hierarchy to console - LIVE EDITING TEST
          console.log('=== LINEAGE HIERARCHY (LIVE) ===');
          console.log('Input data:', keyStuff.slice(0, 10)); // First 10 items
          console.log('Hierarchy structure:', hierarchy);
          console.log('================================');

          // Update state with new data
          setHierarchyData(hierarchy);
          
        } else {
          // Clear data if empty
          setHierarchyData([]);
        }
      } catch (error) {
      } finally {
        setIsLoading(false);
      }
    }, 100);
    
    return () => clearTimeout(timer);
  }, [keyStuff]);
  
  // Store expanded items in localStorage to persist between renders
  useEffect(() => {
    try {
      // Load expanded items from localStorage on mount
      const storedItems = localStorage.getItem('taxonium_expanded_items');
      if (storedItems) {
        setExpandedItems(JSON.parse(storedItems));
      }
    } catch (e) {
    }
  }, []);

  // Save expanded items to localStorage when changed
  useEffect(() => {
    try {
      if (Object.keys(expandedItems).length > 0) {
        localStorage.setItem('taxonium_expanded_items', JSON.stringify(expandedItems));
      }
    } catch (e) {
    }
  }, [expandedItems]);
  
  

  // Handle category selection with useCallback for better memoization
  const handleCategoryClick = useCallback((category) => {
    const newSelectedValue = category === selectedCategory ? null : category;
    onCategorySelect(newSelectedValue);
  }, [onCategorySelect, selectedCategory]);

  // Reset selected category
  const handleReset = useCallback(() => {
    onCategorySelect(null);
  }, [onCategorySelect]);
  
  // Toggle expand/collapse of a lineage
  const toggleExpand = useCallback((lineageName, e) => {
    e.stopPropagation();
    setExpandedItems(prev => ({
      ...prev,
      [lineageName]: !prev[lineageName]
    }));
  }, []);

  // Handle merge lineage operation
  const handleMergeLineage = useCallback((lineageName, e) => {
    e.stopPropagation();
    if (onMergeLineage) {
      onMergeLineage(lineageName);
    }
  }, [onMergeLineage]);

  // Handle edit lineage operation
  const handleEditLineage = useCallback((lineageName, e) => {
    e.stopPropagation();
    if (onEditLineage) {
      onEditLineage(lineageName);
    }
  }, [onEditLineage]);

  // Handle export JSONL
  const handleExportJsonl = useCallback(async () => {
    if (!backend || backend.type !== 'server' || !backend.backend_url) {
      toast.error('Export requires server backend');
      return;
    }

    try {
      const url = `${backend.backend_url}/export/jsonl`;
      const link = document.createElement('a');
      link.href = url;
      link.download = 'exported_tree.jsonl';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      toast.success('JSONL export started');
    } catch (error) {
      console.error('Error exporting JSONL:', error);
      toast.error('Failed to export JSONL');
    }
  }, [backend]);

  // Handle export protobuf
  const handleExportPb = useCallback(async () => {
    if (!backend || backend.type !== 'server' || !backend.backend_url) {
      toast.error('Export requires server backend');
      return;
    }

    try {
      toast('Generating .pb.gz (this may take a moment)...');
      const url = `${backend.backend_url}/export/pb`;
      const link = document.createElement('a');
      link.href = url;
      link.download = 'exported_tree.pb.gz';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Error exporting pb:', error);
      toast.error('Failed to export protobuf');
    }
  }, [backend]);

  // Handle export metadata TSV
  const handleExportMetadata = useCallback(async () => {
    if (!backend || backend.type !== 'server' || !backend.backend_url) {
      toast.error('Export requires server backend');
      return;
    }

    try {
      const url = `${backend.backend_url}/export/metadata`;
      const link = document.createElement('a');
      link.href = url;
      link.download = 'exported_metadata.tsv';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      toast.success('Metadata TSV export started');
    } catch (error) {
      console.error('Error exporting metadata:', error);
      toast.error('Failed to export metadata');
    }
  }, [backend]);

  // Handle zoom to lineage operation
  const handleZoomToLineage = useCallback(async (lineageName: string, e: React.MouseEvent) => {
    e.stopPropagation();

    if (!view || !backend || !config || !deckSize) {
      console.warn('Missing required props for zoom functionality');
      return;
    }

    if (backend.type !== 'server' || !backend.backend_url) {
      console.warn('Zoom functionality requires server backend');
      return;
    }

    try {
      // Create a search query to find all nodes with this lineage
      const searchSpec = {
        key: `zoom_${Date.now()}`, // Unique key for this search
        type: colorByField, // Use the field name directly (e.g., "meta_annotation_1")
        method: SearchMethod.TEXT_EXACT, // Use exact text matching
        text: lineageName, // The lineage name to search for
        min_tips: 0
      };

      // Use boundsForQueries if available, otherwise use default bounds
      const minY = boundsForQueries?.min_y ?? -Infinity;
      const maxY = boundsForQueries?.max_y ?? Infinity;
      const minX = boundsForQueries?.min_x ?? -Infinity;
      const maxX = boundsForQueries?.max_x ?? Infinity;

      const url = `${backend.backend_url}/search?json=${encodeURIComponent(JSON.stringify(JSON.stringify(searchSpec)))}&min_y=${minY}&max_y=${maxY}&min_x=${minX}&max_x=${maxX}`;

      console.log('DEBUG: Zoom search spec:', searchSpec);
      console.log('DEBUG: Zoom search URL:', url);

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const searchResult = await response.json();
      console.log('DEBUG: Search result:', searchResult);

      // Check for data in either overview or data field
      const nodes = searchResult.overview || searchResult.data;
      if (!nodes || nodes.length === 0) {
        console.log('DEBUG: No node data found in search result');
        return;
      }

      // Calculate bounds similar to useSearch zoom logic
      const min_y = Math.min(...nodes.map((d: any) => d.y));
      const max_y = Math.max(...nodes.map((d: any) => d.y));

      console.log(`DEBUG: Found ${nodes.length} nodes for lineage ${lineageName}`);
      console.log(`DEBUG: Y range: ${min_y} to ${max_y}`);

      // Calculate zoom level with padding to ensure all nodes are visible
      const oldViewState = { ...view.viewState };
      const yRange = max_y - min_y;
      const padding = 50000 / (config.num_nodes || 10000);
      // Add extra margin to prevent nodes from being cut off at the edges
      const extraMargin = yRange * 0.15; // 15% extra margin on each side
      const newZoom = 9 - Math.log2(yRange + padding + extraMargin);

      console.log(`DEBUG: Y range: ${yRange}, padding: ${padding}, extra margin: ${extraMargin}`);
      console.log(`DEBUG: Calculated zoom level: ${newZoom}`);

      // Calculate target position - shift slightly upward to give more space at bottom
      const bottomBias = yRange * 0.05; // Shift target 5% of range upward
      const new_target = [oldViewState.target[0], (min_y + max_y) / 2 - bottomBias];

      console.log(`DEBUG: New target: [${new_target[0]}, ${new_target[1]}]`);

      const viewState = {
        ...view.viewState,
        real_target: undefined,
        target: new_target,
        zoom: [
          (view.viewState.zoom as [number, number])[0],
          newZoom,
        ],
      };

      console.log('DEBUG: Applying view state change:', viewState);

      // Apply the zoom with the same parameters as search zoom
      view.onViewStateChange({
        viewState: viewState,
        interactionState: "isZooming",
        oldViewState,
        basicTarget: true,
      });

      // Add a small delay to ensure the view state change is processed
      // and then trigger a potential refresh to fix color rendering
      setTimeout(() => {
        // Trigger a potential re-render by calling onViewStateChange again with the same state
        // This can help ensure colors are properly applied after zoom
        view.onViewStateChange({
          viewState: viewState,
          interactionState: {},
          oldViewState: viewState,
          basicTarget: true,
        });
      }, 100);

      console.log(`SUCCESS: Zoomed to lineage ${lineageName}`);


    } catch (error) {
      console.error('Error zooming to lineage:', error);
    }
  }, [view, backend, config, deckSize, colorByField, boundsForQueries]);
  
  
  // Get color for lineage, using hierarchical colors if enabled
  const getLineageColor = useCallback((lineageName) => {
    if (useHierarchicalColors && isPangoLineage(lineageName)) {
      const color = generatePangoLineageColor(lineageName, keyStuff);
      return color;
    }
    
    // Find in keyStuff
    const item = keyStuff?.find(item => item.value === lineageName);
    const fallbackColor = item?.color || [100, 100, 100];
    return fallbackColor;
  }, [keyStuff, useHierarchicalColors]);

  // Function to check if a lineage is part of another lineage's hierarchy
  // Returns: 'self' if exact match, 'parent' if lineage is parent, 'child' if lineage is child, null if unrelated
  const checkLineageRelationship = useCallback((lineageName, referenceLineage) => {
    if (!lineageName || !referenceLineage) return null;
    
    // Exact match
    if (lineageName === referenceLineage) return 'self';
    
    // Determine if node is in a highlighted lineage
    // This function is used to check if a node should be highlighted when a lineage is selected
    // When we select "AY", we want to highlight all nodes in "AY", "AY.4", "AY.4.2", etc.
    
    // Check if the lineage is a sub-lineage of the reference
    // For example, if reference is "AY", then "AY.4" and "AY.4.2" are sub-lineages
    if (lineageName.startsWith(referenceLineage + '.')) {
      return 'child'; // Node is a sub-lineage of the selected lineage
    }
    
    // Check if the reference is a sub-lineage of this lineage
    // For example, if lineage is "AY" and reference is "AY.4", then lineage is a parent
    if (referenceLineage.startsWith(lineageName + '.')) {
      return 'parent'; // Node is a parent of the selected lineage
    }
    
    // If nothing matched, they're unrelated
    return null;
  }, []);

  // Memoize hierarchical rendering to improve performance
  const renderHierarchicalItems = useMemo(() => {
    // Recursive function to render a node and its children
    const renderNode = (node, level = 0) => {
      // Early return for null nodes
      if (!node || !node.name) return null;
      
      const isExpanded = expandedItems[node.name] || false;
      const hasChildren = node.children && node.children.length > 0;
      const nodeColor = useHierarchicalColors 
        ? getLineageColor(node.name)
        : node.color;
      
      
      // Filter by search term if one exists
      if (searchTerm && !node.name.toLowerCase().includes(searchTerm.toLowerCase())) {
        // If this node doesn't match but has children that might match, still render
        if (hasChildren) {
          const matchingChildren = node.children
            .map(child => renderNode(child, level + 1))
            .filter(Boolean);
          
          if (matchingChildren.length === 0) return null;
          
          // If there are matching children, render a collapsed version of this node
          return (
            <React.Fragment key={node.name}>
              <li 
                className="text-sm cursor-pointer py-1 px-1 flex justify-between rounded bg-gray-50"
                onClick={() => handleCategoryClick(node.name)}
                style={{ paddingLeft: `${(level * 10) + 8}px` }}
              >
                <div className="flex items-center flex-grow">
                  <button 
                    onClick={(e) => toggleExpand(node.name, e)}
                    className="mr-1 focus:outline-none"
                  >
                    {isExpanded ? 
                      <FaChevronDown className="text-gray-500 w-3 h-3" /> : 
                      <FaChevronRight className="text-gray-500 w-3 h-3" />
                    }
                  </button>
                  <span 
                    className="inline-block w-3 h-3 mr-2 rounded-full"
                    style={{ backgroundColor: `rgb(${nodeColor.join(',')})` }}
                  />
                  <span className="mr-2 text-gray-400 italic">
                    {node.name} <span className="text-gray-500">({matchingChildren.length} matches below)</span>
                  </span>
                </div>
              </li>
              
              {isExpanded && (
                <ul className="ml-0">
                  {matchingChildren}
                </ul>
              )}
            </React.Fragment>
          );
        } else {
          return null;
        }
      }
      
      const isHovered = hoveredKey === node.name;
      const relationship = checkLineageRelationship(node.name, selectedCategory);
      
      return (
        <React.Fragment key={node.name}>
          <li
            data-lineage-name={node.name}
            className={`text-sm cursor-pointer py-1 px-1 flex justify-between rounded ${
              relationship === 'self' ? "bg-blue-100 font-medium" :
              relationship === 'parent' ? "bg-blue-50" :
              relationship === 'child' ? "bg-indigo-50" :
              isHovered ? "bg-yellow-50 ring-1 ring-yellow-200" :
              "hover:bg-gray-100"
            }`}
            onClick={() => handleCategoryClick(node.name)}
            onMouseEnter={() => setHoveredKey && setHoveredKey(node.name)}
            onMouseLeave={() => setHoveredKey && setHoveredKey(null)}
            style={{ paddingLeft: `${(level * 10) + 8}px` }}
          >
            <div
              className="flex items-center flex-grow"
              style={{
                maxWidth: "45%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap"
              }}
            >
              {hasChildren ? (
                <button
                  onClick={(e) => toggleExpand(node.name, e)}
                  className="mr-1 focus:outline-none"
                >
                  {isExpanded ?
                    <FaChevronDown className="text-gray-500 w-3 h-3" /> :
                    <FaChevronRight className="text-gray-500 w-3 h-3" />
                  }
                </button>
              ) : (
                <span className="w-3 mr-1"></span>
              )}

              <span
                className={`inline-block w-3 h-3 mr-2 rounded-full ${
                  relationship === 'self' ? "ring-2 ring-blue-400" :
                  relationship === 'parent' ? "ring-1 ring-blue-300" :
                  relationship === 'child' ? "ring-1 ring-indigo-300" : ""
                }`}
                style={{ backgroundColor: `rgb(${nodeColor.join(',')})` }}
              />

              <span className="mr-2 truncate">
                {node.name}
                {relationship === 'self' && (
                  <FaCheck className="ml-1 text-blue-600 inline-block" size={10} />
                )}
              </span>
            </div>

            {/* Hover action buttons */}
            {isHovered && (
              <div className="flex items-center mr-2 space-x-1">
                <button
                  onClick={(e) => handleZoomToLineage(node.name, e)}
                  className="p-1 bg-green-100 hover:bg-green-200 text-green-700 rounded border border-green-200 transition-colors"
                  title="Zoom to lineage nodes"
                >
                  <FaSearch size={10} />
                </button>
                <button
                  onClick={(e) => handleMergeLineage(node.name, e)}
                  className="p-1 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded border border-orange-200 transition-colors"
                  title="Merge with parent lineage"
                >
                  <FaArrowUp size={10} />
                </button>
                <button
                  onClick={(e) => handleEditLineage(node.name, e)}
                  className={`p-1 rounded border transition-colors ${
                    editingLineage === node.name 
                      ? "bg-amber-200 border-amber-400 text-amber-800 animate-pulse" 
                      : "bg-blue-100 hover:bg-blue-200 text-blue-700 border-blue-200"
                  }`}
                  title={editingLineage === node.name ? "Currently editing - click a tree node" : "Edit lineage root"}
                >
                  <FaEdit size={10} />
                </button>
              </div>
            )}
            
            {/* Display count information */}
            <div className="flex items-center text-xs space-x-1">
              {/* Descendant lineages count */}
              <div
                className="flex items-center bg-blue-50 px-1.5 py-0.5 rounded text-blue-700 border border-blue-200"
                title="Descendant lineages (hover to highlight in tree)"
                onMouseEnter={() => {
                  if (!setHighlightedRoots) return;
                  // Collect all descendant lineage names from the hierarchy
                  const collect = (n: any, acc: string[]) => {
                    if (n.children) {
                      for (const child of n.children) {
                        acc.push(child.name);
                        collect(child, acc);
                      }
                    }
                  };
                  const descendants: string[] = [];
                  collect(node, descendants);
                  setHighlightedRoots(descendants.length > 0 ? descendants : null);
                }}
                onMouseLeave={() => setHighlightedRoots && setHighlightedRoots(null)}
              >
                <FaSitemap className="w-3 h-3 mr-1" />
                <span className="tabular-nums">{(() => {
                  const item = keyStuff?.find(item => item.value === node.name);
                  return item?.descendantLineages || 0;
                })()}</span>
              </div>

              {/* Descendant leaves count */}
              <div className="flex items-center bg-green-50 px-1.5 py-0.5 rounded text-green-700 border border-green-200" title="Descendant samples (leaves)">
                <FaLeaf className="w-3 h-3 mr-1" />
                <span className="tabular-nums">{(() => {
                  const item = keyStuff?.find(item => item.value === node.name);
                  return item?.descendantLeaves || 0;
                })()}</span>
              </div>
            </div>
          </li>
          
          {isExpanded && hasChildren && (
            <ul className="ml-0">
              {node.children.map(child => renderNode(child, level + 1))}
            </ul>
          )}
        </React.Fragment>
      );
    };
    
    return hierarchyData.map(node => renderNode(node));
  }, [hierarchyData, expandedItems, searchTerm, selectedCategory, useHierarchicalColors, getLineageColor, handleCategoryClick, toggleExpand, checkLineageRelationship]);
  
  



  // CSS classes for panel visibility
  const containerClasses = `h-full flex flex-col bg-white border-r overflow-hidden shadow-sm ${!isVisible ? "hidden" : ""}`;
  const containerStyle = { width: '461px' }; // 60% of the previous 768px width





  return (
    <div className={containerClasses} style={containerStyle}>
      <div className="px-4 py-4 border-b border-gray-200 flex justify-between items-center bg-gradient-to-r from-gray-50 to-white">
        <div className="flex flex-col">
          <h2 className="font-bold text-gray-800 text-lg">Lineage Explorer</h2>
          {editingLineage && (
            <div className="text-xs text-blue-600 mt-1 font-medium bg-blue-50 px-2 py-1 rounded flex items-center">
              <span className="animate-pulse mr-2">🎯</span>
              Editing: {editingLineage}
            </div>
          )}
        </div>
        <div className="flex space-x-2">
          {editingLineage && onCancelEdit && (
            <Button
              className="text-xs py-2 px-3 bg-red-100 hover:bg-red-200 text-red-700 border border-red-200 rounded-md"
              onClick={onCancelEdit}
            >
              Cancel Edit
            </Button>
          )}
          <Button
            className="text-xs py-2 px-3 bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-200 rounded-md"
            onClick={toggleSidebar}
          >
            Hide Panel
          </Button>
        </div>
      </div>
      
      {/* Edit Mode Instructions Banner */}
      {editingLineage && (
        <div className="px-4 py-3 bg-amber-50 border-b border-amber-200">
          <div className="flex items-center">
            <span className="text-amber-600 mr-2 text-lg">⚠️</span>
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-800">
                Click on a tree node to set it as the new root for lineage "{editingLineage}"
              </p>
              <p className="text-xs text-amber-700 mt-1">
                This will reassign all descendants of the selected node to this lineage
              </p>
            </div>
          </div>
        </div>
      )}
      
      {/* Summary Stats */}
      <div className="border-b px-4 py-3 bg-gray-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-1">
              <span className="text-sm font-medium text-gray-700">Total Lineages:</span>
              <span className="text-sm font-bold text-gray-900">
                {isLoading ? '—' : (keyStuff?.length || 0).toLocaleString()}
              </span>
            </div>
            {hierarchyData.length > 0 && (
              <div className="flex items-center space-x-1">
                <span className="text-xs text-gray-500">•</span>
                <span className="text-xs text-gray-600">
                  {hierarchyData.length} root lineages
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center space-x-2">
            {editingLineage && (
              <div className="text-xs text-amber-700 bg-amber-100 px-2 py-1 rounded border border-amber-300 animate-pulse">
                🎯 Editing Mode
              </div>
            )}
            {selectedCategory && (
              <div className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded border border-blue-200">
                {selectedCategory} active
              </div>
            )}
          </div>
        </div>
      </div>
      
      <div className="flex-grow flex flex-col overflow-hidden">
        {/* Improved Toolbar */}
        <div className="p-3 border-b bg-white">
          <div className="flex items-center space-x-2">
            <div className="relative flex-grow">
              <input
                type="text"
                placeholder="Search lineages..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-8 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <FaFilter className="absolute text-gray-400 left-2.5 top-3" size={12} />
            </div>

            {selectedCategory && (
              <Button
                className="text-xs py-2 px-3 bg-red-50 hover:bg-red-100 text-red-700 border-red-200"
                onClick={handleReset}
              >
                Clear Selection
              </Button>
            )}
          </div>

        </div>

        {/* Downloads */}
        <div className="px-2 py-1.5 border-b border-gray-200" style={{ fontSize: '10px', lineHeight: '18px' }}>
          <div className="flex items-center gap-1 text-gray-400 mb-0.5">
            <span style={{ width: '42px', flexShrink: 0 }}></span>
            <span className="flex-1 text-center">Taxonium tree</span>
            <span className="flex-1 text-center">UShER tree</span>
            <span className="flex-1 text-center">Lineage assignments</span>
          </div>
          <div className="flex items-center gap-1 text-gray-500">
            <span className="text-gray-400" style={{ width: '42px', flexShrink: 0 }}>Edited</span>
            <button onClick={handleExportJsonl} className="flex-1 text-blue-600 hover:text-blue-800 underline bg-transparent border-0 cursor-pointer p-0 text-center" style={{ fontSize: '10px' }} title="Reflects edits">.jsonl.gz</button>
            <button onClick={handleExportPb} className="flex-1 text-blue-600 hover:text-blue-800 underline bg-transparent border-0 cursor-pointer p-0 text-center" style={{ fontSize: '10px' }} title="Reflects edits">.pb.gz</button>
            <button onClick={handleExportMetadata} className="flex-1 text-blue-600 hover:text-blue-800 underline bg-transparent border-0 cursor-pointer p-0 text-center" style={{ fontSize: '10px' }} title="Reflects edits">.tsv</button>
          </div>
          {pipelineDownloads && pipelineDownloads.length > 0 && (
            <div className="flex items-center gap-1 text-gray-500">
              <span className="text-gray-400" style={{ width: '42px', flexShrink: 0 }}>Original</span>
              {['.jsonl.gz', '.pb.gz', '.tsv'].map(ext => {
                const dl = pipelineDownloads.find(d => d.name.endsWith(ext));
                return dl ? (
                  <a key={ext} href={`http://localhost:8001/download?path=${encodeURIComponent(dl.path)}`} download={dl.name} className="flex-1 text-center text-gray-500 hover:text-gray-700 underline" style={{ fontSize: '10px' }}>{ext}</a>
                ) : (
                  <span key={ext} className="flex-1 text-center text-gray-300" style={{ fontSize: '10px' }}>{ext}</span>
                );
              })}
            </div>
          )}
        </div>
          
          {/* Edit History Log */}
          {editHistory && editHistory.length > 0 && (
            <EditHistoryPanel editHistory={editHistory} onUndo={onUndo} backendUrl={backend?.backend_url} />
          )}

          {/* Lineage list - Always hierarchical */}
          <div className="flex-grow overflow-y-auto" ref={listContainerRef}>
            {isLoading ? (
              <div className="text-center py-4 text-gray-500">
                Loading lineage data...
              </div>
            ) : (
              <>
                {hierarchyData.length > 0 ? (
                  <ul className="space-y-0">
                    {renderHierarchicalItems}
                  </ul>
                ) : (
                  <div className="text-center py-4 text-gray-500">
                    {searchTerm ? 'No matching lineages found' : 'No lineage data available'}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
    </div>
  );
}, arePropsEqual); // Use our custom comparison function

export default LineageTools; 