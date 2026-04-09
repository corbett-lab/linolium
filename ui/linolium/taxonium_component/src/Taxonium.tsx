import React, { useMemo, useState, useRef } from "react";
import Deck from "./Deck";
import SearchPanel from "./components/SearchPanel";
import useTreenomeState from "./hooks/useTreenomeState";
import useView from "./hooks/useView";
import useGetDynamicData from "./hooks/useGetDynamicData";
import useColor from "./hooks/useColor";
import useSearch from "./hooks/useSearch";
import useColorBy from "./hooks/useColorBy";
import useNodeDetails from "./hooks/useNodeDetails";
import useHoverDetails from "./hooks/useHoverDetails";
import type { DeckGLRef } from "@deck.gl/react";
import useBackend from "./hooks/useBackend";
import usePerNodeFunctions from "./hooks/usePerNodeFunctions";
import type { DynamicDataWithLookup } from "./types/backend";
import useConfig from "./hooks/useConfig";
import { useSettings } from "./hooks/useSettings";
import { MdArrowBack, MdArrowUpward } from "react-icons/md";
import { useEffect } from "react";
import type { TreenomeState } from "./types/treenome";
import { useCallback } from "react";
import getDefaultQuery from "./utils/getDefaultQuery";
import type { Query } from "./types/query";
import type { NodeSelectHandler, NodeDetailsLoadedHandler } from "./types/ui";
import { Tooltip as ReactTooltip } from "react-tooltip";
const ReactTooltipAny: any = ReactTooltip;
import { Toaster, toast } from "react-hot-toast";
import LineageTools from "./components/LineageTools";
import type { DeckSize } from "./types/common";
import GlobalErrorBoundary from "./components/GlobalErrorBoundary";
import useLayers from "./hooks/useLayers";
import useFullLineageData from "./hooks/useFullLineageData";

interface SourceData {
  status: string;
  filename: string;
  filetype: string;
  data?: string;
  [key: string]: unknown;
}

interface TaxoniumProps {
  sourceData?: SourceData;
  backendUrl?: string;
  configDict?: Record<string, unknown>;
  configUrl?: string;
  query?: Query;
  updateQuery?: (q: Partial<Query>) => void;
  overlayContent?: React.ReactNode;
  setAboutEnabled?: (val: boolean) => void;
  setOverlayContent?: (content: React.ReactNode) => void;
  onSetTitle?: (title: string) => void;
  onNodeSelect?: NodeSelectHandler;
  onNodeDetailsLoaded?: NodeDetailsLoadedHandler;
  sidePanelHiddenByDefault?: boolean;
  pipelineDownloads?: { name: string; path: string }[];
}


const default_query = getDefaultQuery();

function Taxonium({
  sourceData,

  backendUrl,

  configDict,
  configUrl,
  query,

  updateQuery,
  overlayContent,
  setAboutEnabled,
  setOverlayContent,
  onSetTitle,
  onNodeSelect,
  onNodeDetailsLoaded,
  sidePanelHiddenByDefault,
  pipelineDownloads,
}: TaxoniumProps) {
  const [backupQuery, setBackupQuery] = useState(default_query);
  const backupUpdateQuery = useCallback((newQuery: Partial<Query>) => {
    setBackupQuery((oldQuery) => ({ ...oldQuery, ...newQuery }));
  }, []);
  // if query and updateQuery are not provided, use the backupQuery
  if (!query) {
    query = backupQuery;
  }
  if (!updateQuery) {
    updateQuery = backupUpdateQuery;
  }

  // if no onSetTitle, set it to a noop
  if (!onSetTitle) {
    onSetTitle = () => {};
  }
  // if no setOverlayContent, set it to a noop
  if (!setOverlayContent) {
    setOverlayContent = () => {};
  }

  // if no setAboutEnabled, set it to a noop
  if (!setAboutEnabled) {
    setAboutEnabled = () => {};
  }

  const deckRef = useRef<DeckGLRef | null>(null);
  const jbrowseRef = useRef<any>(null);
  const [mouseDownIsMinimap, setMouseDownIsMinimap] = useState(false);

  const [deckSize, setDeckSize] = useState<DeckSize>({
    width: NaN,
    height: NaN,
  });
  const settings = useSettings({ query, updateQuery });

  // Add state for lineage sidebar visibility
  const [lineageSidebarOpen, setLineageSidebarOpen] = useState(true);

  const view = useView({
    settings,
    deckSize,
    mouseDownIsMinimap,
    lineageSidebarOpen,
  });
  const [sidebarOpen, setSidebarOpen] = useState(!sidePanelHiddenByDefault);

  // Add a state for the selected lineage
  const [selectedLineage, setSelectedLineage] = useState<string | null>(null);

  // Add hoveredKey state for cross-component hover effects
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  // State for lineage editing mode
  const [editingLineage, setEditingLineage] = useState<string | null>(null);

  // Function to handle lineage selection
  const handleLineageSelect = (lineage: string | null) => {
    setSelectedLineage(lineage);
  };

  // Handle ESC key to cancel edit mode
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && editingLineage) {
        handleCancelEdit();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [editingLineage]);

  // Function to handle merging a lineage with its parent
  const handleMergeLineage = async (lineageName: string) => {
    const field = colorBy.colorByField || 'meta_annotation_1';

    if (backend?.type !== 'server' || !backend.backend_url) {
      console.error('No backend server available for merge');
      return;
    }

    try {
      console.log(`Merging ${lineageName} into its tree-parent`);

      const response = await fetch(`${backend.backend_url}/merge-lineage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineageName, field })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      console.log('Merge result:', result);

      setSelectedLineage(null);
      refreshLineageData();
      refreshTreeData();
      fetchEditHistory();

      toast.success(`Merged "${lineageName}" into "${result.parentLineage}" (${result.mergedCount} nodes)`, {
        duration: 4000,
        position: 'top-center',
      });

    } catch (error) {
      console.error('Error merging lineage:', error);
      toast.error(`Failed to merge "${lineageName}": ${error instanceof Error ? error.message : 'Unknown error'}`, {
        duration: 6000,
        position: 'top-center',
      });
    }
  };

  // Function to handle editing a lineage root
  const handleEditLineage = (lineageName: string) => {
    console.log(`Activating node selection mode for lineage "${lineageName}"`);
    console.log(`Click on a tree node to set it as the new root for lineage "${lineageName}". Click "Cancel" to exit selection mode.`);
    setEditingLineage(lineageName);
  };

  // Function to handle node selection for lineage editing
  const handleNodeSelect = async (nodeId: string | number | null) => {
    // If we're in editing mode and a node is selected
    if (editingLineage && nodeId) {
      // Convert nodeId to string if it's a number
      const nodeIdStr = nodeId.toString();

      // Get the lineage field being used
      const field = colorBy.colorByField || 'meta_annotation_1';

      // Check if we have a backend server to call
      if (backend?.type !== 'server' || !backend.backend_url) {
        console.error('Lineage editing requires a backend server connection');
        setEditingLineage(null);
        return;
      }

      try {
        console.log(`Setting node ${nodeIdStr} as new root for lineage ${editingLineage}`);

        const response = await fetch(`${backend.backend_url}/edit-lineage-root`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            lineageName: editingLineage,
            rootNodeId: nodeIdStr,
            field
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        console.log('Edit lineage result:', result);

        // Clear editing mode
        setEditingLineage(null);

        // Clear any existing lineage selection since the lineage has changed
        setSelectedLineage(null);

        // Refresh the lineage data and tree view to reflect the changes
        refreshLineageData();
        refreshTreeData();
        fetchEditHistory();

        console.log(`SUCCESS: ${result.message}`);
        console.log(`Assigned to ${result.assignedCount} nodes, cleared from ${result.clearedCount} nodes under root ${nodeIdStr}`);

        // Show success toast
        toast.success(`✅ Lineage "${editingLineage}" updated successfully!\nAssigned to ${result.assignedCount} nodes.`, {
          duration: 4000,
          position: 'top-center',
        });

      } catch (error) {
        console.error('Error editing lineage:', error);
        setEditingLineage(null);
        
        // Show error toast
        toast.error(`❌ Failed to update lineage "${editingLineage}".\n${error instanceof Error ? error.message : 'Unknown error'}`, {
          duration: 6000,
          position: 'top-center',
        });
      }
    }
    
    // If not in editing mode, call the original onNodeSelect handler if provided
    if (!editingLineage && onNodeSelect) {
      onNodeSelect(nodeId);
    }
  };

  // Function to cancel lineage editing mode
  const handleCancelEdit = () => {
    const wasEditing = editingLineage;
    setEditingLineage(null);
    console.log('Lineage editing mode cancelled');
    
    if (wasEditing) {
      toast(`🚫 Cancelled editing lineage "${wasEditing}"`, {
        duration: 2000,
        position: 'top-center',
        style: {
          background: '#f3f4f6',
          color: '#374151',
        },
      });
    }
  };

  const backend = useBackend(
    backendUrl ? backendUrl : query.backend,
    query.sid,
    sourceData ?? null
  );
  if (!backend) {
    return (
      <div className="p-4 bg-red-50 text-red-800">
        Failed to initialise backend.
      </div>
    );
  }
  let hoverDetails = useHoverDetails();
  const gisaidHoverDetails = useNodeDetails("gisaid-hovered", backend);
  if (window.location.toString().includes("epicov.org")) {
    hoverDetails = gisaidHoverDetails;
  }
  const selectedDetails = useNodeDetails("selected", backend);

  const config = useConfig(
    backend,
    view,
    setOverlayContent,
    onSetTitle,
    query,
    configDict,
    configUrl
  );
  const colorBy = useColorBy(config, query, updateQuery);
  const [additionalColorMapping, setAdditionalColorMapping] = useState({});
  const colorMapping = useMemo(() => {
    const initial = (config as any).colorMapping ? (config as any).colorMapping : {};
    return { ...initial, ...additionalColorMapping };
  }, [(config as any).colorMapping, additionalColorMapping]);
  // colorHook will be defined after fullLineageData

  //TODO: this is always true for now
  (config as any).enable_ns_download = true;

  const xType = query.xType ? query.xType : "x_dist";

  const setxType = useCallback(
    (xType: string) => {
      updateQuery!({ xType });
    },
    [updateQuery]
  );

  const { data, boundsForQueries, isCurrentlyOutsideBounds, refreshTreeData } =
    useGetDynamicData(
      backend,
      colorBy,
      view.viewState,
      config,
      xType,
      deckSize
    );

  const perNodeFunctions = usePerNodeFunctions(
    data as unknown as DynamicDataWithLookup,
    config
  );

  useEffect(() => {
    // If there is no distance data, default to time
    // This can happen with e.g. nextstrain json
    if (data.base_data && data.base_data.nodes) {
      const n = data.base_data.nodes[0];
      if (!n.hasOwnProperty("x_dist")) {
        setxType("x_time");
      } else if (!n.hasOwnProperty("x_time")) {
        setxType("x_dist");
      }
    }
  }, [data.base_data, setxType]);

  const search = useSearch({
    data,
    config,
    boundsForQueries,
    view,
    backend,
    query,
    updateQuery,
    deckSize,
    xType,
    settings,
  });

  // Get full lineage data for LineageTools (not subsampled keyStuff)
  const { lineageData: fullLineageData, isLoading, error, refreshData: refreshLineageData } = useFullLineageData(backend, 'meta_annotation_1');

  // Edit history state
  const [editHistory, setEditHistory] = useState<Array<{
    id: number;
    action: string;
    lineageName: string;
    parentLineage?: string;
    description: string;
    timestamp: string;
    affectedLineages?: string[];
  }>>([]);

  const fetchEditHistory = useCallback(async () => {
    if (backend?.type !== 'server' || !backend.backend_url) return;
    try {
      const response = await fetch(`${backend.backend_url}/edit-history`);
      if (response.ok) {
        setEditHistory(await response.json());
      }
    } catch (e) { /* non-critical */ }
  }, [backend]);

  const handleUndo = useCallback(async (editId?: number) => {
    if (backend?.type !== 'server' || !backend.backend_url) return;
    try {
      const response = await fetch(`${backend.backend_url}/undo-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editId }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Undo failed');
      }
      const result = await response.json();
      refreshLineageData();
      refreshTreeData();
      fetchEditHistory();
      toast.success(`Undid: ${result.undone}`, { duration: 3000, position: 'top-center' });
    } catch (error) {
      toast.error(`Undo failed: ${error instanceof Error ? error.message : 'Unknown error'}`, {
        duration: 4000, position: 'top-center',
      });
    }
  }, [backend, refreshLineageData, refreshTreeData, fetchEditHistory]);

  // Initialize colorHook with lineage data for hierarchical coloring
  const colorHook = useColor(config, colorMapping, colorBy.colorByField, fullLineageData);

  const toggleLineageSidebar = () => {
    setLineageSidebarOpen(!lineageSidebarOpen);
    setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 100);
  };

  const toggleSidebar = () => {
    setSidebarOpen(!sidebarOpen);
    setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 100);
  };

  const treenomeState = useTreenomeState(data, deckRef, view, settings);

  const isPangoLineageField = useMemo(() => {
    const result = (
      colorBy.colorByField === "meta_pangolin_lineage" ||
      colorBy.colorByField === "meta_annotation_1" ||
      colorBy.colorByField === "Annotation 1" ||
      (typeof colorBy.colorByField === "string" &&
       (colorBy.colorByField.toLowerCase().includes("pango") ||
        colorBy.colorByField.toLowerCase().includes("lineage")))
    );


    return result;
  }, [colorBy.colorByField, data]);

  return (
    <GlobalErrorBoundary>
      <div className="w-full h-full flex">
        <Toaster />
      <ReactTooltipAny
        id="global-tooltip"
        delayHide={400}
        className="infoTooltip"
        place="top"
        backgroundColor="#e5e7eb"
        textColor="#000"
        effect="solid"
      />
      <div className="flex-grow overflow-hidden flex flex-row">
        <LineageTools
          keyStuff={fullLineageData}
          colorHook={colorHook}
          colorByField={colorBy.colorByField || ''}
          onCategorySelect={handleLineageSelect}
          selectedCategory={selectedLineage}
          isPangoLineageField={isPangoLineageField}
          toggleSidebar={toggleLineageSidebar}
          isVisible={lineageSidebarOpen}
          data={data}
          xType={xType}
          hoveredKey={hoveredKey}
          setHoveredKey={setHoveredKey}
          onMergeLineage={handleMergeLineage}
          onEditLineage={handleEditLineage}
          editingLineage={editingLineage}
          onCancelEdit={handleCancelEdit}
          view={view}
          backend={backend}
          config={config}
          deckSize={deckSize}
          boundsForQueries={boundsForQueries}
          pipelineDownloads={pipelineDownloads}
          editHistory={editHistory}
          onUndo={handleUndo}
        />

        <div className="flex flex-col md:flex-row overflow-hidden flex-grow">
          <div
            className={`h-1/2 md:h-full overflow-hidden w-full relative ${editingLineage ? 'edit-mode' : ''}`}
            style={editingLineage ? { cursor: 'crosshair' } : {}}
          >
            {!lineageSidebarOpen && (
              <button 
                onClick={toggleLineageSidebar}
                className="absolute z-10 left-0 top-1/2 transform -translate-y-1/2 bg-white rounded-r py-2 px-1 shadow-md border border-l-0"
                title="Show Lineage Tools"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )}

            {/* Edit mode overlay */}
            {editingLineage && (
              <div className="absolute inset-0 z-5 pointer-events-none">
                <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-amber-100 border border-amber-300 px-4 py-2 rounded-lg shadow-lg">
                  <p className="text-sm font-medium text-amber-800 flex items-center">
                    <span className="animate-pulse mr-2">🎯</span>
                    Click a tree node to set as new root for "{editingLineage}"
                  </p>
                  <p className="text-xs text-amber-700 mt-1">
                    Press ESC to cancel
                  </p>
                </div>
                <div className="absolute inset-0 bg-amber-50 opacity-10"></div>
              </div>
            )}

            <Deck
              statusMessage={backend.statusMessage}
              data={data}
              search={search}
              view={view}
              colorHook={colorHook}
              colorBy={colorBy}
              config={config}
              hoverDetails={hoverDetails}
              selectedDetails={selectedDetails}
              xType={xType}
              settings={settings}
              setDeckSize={setDeckSize}
              deckSize={deckSize}
              deckRef={deckRef}
              jbrowseRef={jbrowseRef}
              setAdditionalColorMapping={setAdditionalColorMapping}
              treenomeState={treenomeState as unknown as TreenomeState}
              mouseDownIsMinimap={mouseDownIsMinimap}
              setMouseDownIsMinimap={setMouseDownIsMinimap}
              isCurrentlyOutsideBounds={false}
              onNodeSelect={handleNodeSelect}
              lineageSidebarOpen={lineageSidebarOpen}
              hoveredKey={hoveredKey}
              setHoveredKey={setHoveredKey}
              onLineageLabelClick={handleLineageSelect}
            />
          </div>

          <div
            className={
              sidebarOpen
                ? "w-full md:w-80 min-h-0 h-1/2 md:h-full bg-white shadow-xl border-t md:border-0 overflow-y-auto md:overflow-hidden"
                : "bg-white shadow-xl"
            }
          >
            {!sidebarOpen && (
              <button onClick={toggleSidebar}>
                <br />
                {window.innerWidth > 768 ? (
                  <MdArrowBack className="mx-auto w-5 h-5 sidebar-toggle" />
                ) : (
                  <MdArrowUpward className="mx-auto w-5 h-5 sidebar-toggle" />
                )}
              </button>
            )}

            {sidebarOpen && (
              <SearchPanel
                className="flex-grow min-h-0 h-full bg-white shadow-xl border-t md:border-0 overflow-y-auto md:overflow-hidden"
                backend={backend}
                search={search}
                colorBy={colorBy}
                colorHook={colorHook}
                config={config}
                selectedDetails={selectedDetails}
                xType={xType}
                setxType={setxType}
                settings={settings}
                treenomeState={treenomeState}
                view={view}
                overlayContent={overlayContent}
                setAboutEnabled={setAboutEnabled}
                perNodeFunctions={perNodeFunctions}
                toggleSidebar={toggleSidebar}
              />
            )}
          </div>
        </div>
      </div>
    </div>
    </GlobalErrorBoundary>
  );
}

export default React.memo(Taxonium);
