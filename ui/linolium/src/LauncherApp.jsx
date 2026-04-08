import React, { useState, useCallback, useRef, useEffect } from 'react';

/**
 * LauncherApp - A modern, sleek launcher UI for the lineage curation pipeline
 * 
 * Allows users to:
 * - Drag/drop or upload .pb files
 * - Configure propose_sublineages.py parameters
 * - Run the autolin pipeline
 * - View progress and logs
 * - Launch Taxonium when complete
 */

// Pipeline stages for progress tracking
const STAGES = {
  IDLE: 'idle',
  UPLOADING: 'uploading',
  PROPOSING: 'proposing',
  CONVERTING: 'converting',
  LOADING: 'loading',
  COMPLETE: 'complete',
  ERROR: 'error'
};

const STAGE_LABELS = {
  [STAGES.IDLE]: 'Ready',
  [STAGES.UPLOADING]: 'Uploading file...',
  [STAGES.PROPOSING]: 'Running propose_sublineages.py...',
  [STAGES.CONVERTING]: 'Converting to Taxonium format...',
  [STAGES.LOADING]: 'Loading viewer...',
  [STAGES.COMPLETE]: 'Complete!',
  [STAGES.ERROR]: 'Error'
};

function LauncherApp({ onLaunchTaxonium }) {
  // File state
  const [file, setFile] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  // Pipeline parameters (from propose_sublineages.py argparser)
  const [params, setParams] = useState({
    minsamples: 10,
    distinction: 1,
    recursive: true,
    cutoff: 0.95,
    floor: 0,
    verbose: true,
    clear: false
  });

  // Advanced options toggle
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Pipeline state
  const [stage, setStage] = useState(STAGES.IDLE);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const [outputFile, setOutputFile] = useState(null);

  // Logs container ref for auto-scroll
  const logsRef = useRef(null);

  // Auto-scroll logs
  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  // Add log message
  const addLog = useCallback((message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, { timestamp, message, type }]);
  }, []);

  // Handle file drop
  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);

    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && (droppedFile.name.endsWith('.pb') || droppedFile.name.endsWith('.pb.gz'))) {
      setFile(droppedFile);
      addLog(`Selected file: ${droppedFile.name} (${(droppedFile.size / 1024 / 1024).toFixed(2)} MB)`);
    } else {
      addLog('Please select a .pb or .pb.gz file', 'error');
    }
  }, [addLog]);

  // Handle file input change
  const handleFileChange = useCallback((e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile && (selectedFile.name.endsWith('.pb') || selectedFile.name.endsWith('.pb.gz'))) {
      setFile(selectedFile);
      addLog(`Selected file: ${selectedFile.name} (${(selectedFile.size / 1024 / 1024).toFixed(2)} MB)`);
    } else if (selectedFile) {
      addLog('Please select a .pb or .pb.gz file', 'error');
    }
  }, [addLog]);

  // Handle drag events
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  // Update parameter
  const updateParam = useCallback((key, value) => {
    setParams(prev => ({ ...prev, [key]: value }));
  }, []);

  // Run the pipeline
  const runPipeline = useCallback(async () => {
    if (!file) {
      addLog('No file selected', 'error');
      return;
    }

    setError(null);
    setLogs([]);
    setProgress(0);

    try {
      // Stage 1: Upload file
      setStage(STAGES.UPLOADING);
      addLog('Uploading file to server...');
      setProgress(10);

      const formData = new FormData();
      formData.append('file', file);

      const uploadResponse = await fetch('http://localhost:8001/upload', {
        method: 'POST',
        body: formData
      });

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed: ${uploadResponse.statusText}`);
      }

      const uploadResult = await uploadResponse.json();
      addLog(`File uploaded: ${uploadResult.filename}`, 'success');
      setProgress(25);

      // Stage 2: Run propose_sublineages
      setStage(STAGES.PROPOSING);
      addLog('Running propose_sublineages.py...');
      addLog(`Parameters: minsamples=${params.minsamples}, distinction=${params.distinction}, recursive=${params.recursive}`);

      const proposeResponse = await fetch('http://localhost:8001/run-autolin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputFile: uploadResult.path,
          params: {
            minsamples: params.minsamples,
            distinction: params.distinction,
            recursive: params.recursive,
            cutoff: params.cutoff,
            floor: params.floor,
            verbose: params.verbose,
            clear: params.clear
          }
        })
      });

      if (!proposeResponse.ok) {
        const errorData = await proposeResponse.json();
        throw new Error(errorData.error || 'Pipeline failed');
      }

      // Stream logs from the response
      const reader = proposeResponse.body.getReader();
      const decoder = new TextDecoder();
      let pipelineResult = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);
        const lines = text.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            
            if (data.type === 'log') {
              addLog(data.message);
            } else if (data.type === 'stage') {
              if (data.stage === 'proposing') {
                setStage(STAGES.PROPOSING);
                setProgress(40);
              } else if (data.stage === 'converting') {
                setStage(STAGES.CONVERTING);
                setProgress(70);
              }
            } else if (data.type === 'complete') {
              pipelineResult = data;
            } else if (data.type === 'error') {
              throw new Error(data.message);
            }
          } catch (parseError) {
            // Not JSON, treat as plain log
            if (line.trim()) {
              addLog(line);
            }
          }
        }
      }

      if (!pipelineResult) {
        throw new Error('Pipeline did not return a result');
      }

      setProgress(90);
      addLog(`Pipeline complete! Output: ${pipelineResult.outputFile}`, 'success');
      setOutputFile(pipelineResult.outputFile);

      // Stage 3: Load viewer
      setStage(STAGES.LOADING);
      addLog('Starting Taxonium viewer...');
      setProgress(95);

      // Small delay to ensure backend is ready
      await new Promise(resolve => setTimeout(resolve, 1000));

      setStage(STAGES.COMPLETE);
      setProgress(100);
      addLog('Ready to view!', 'success');

    } catch (err) {
      console.error('Pipeline error:', err);
      setStage(STAGES.ERROR);
      setError(err.message);
      addLog(`Error: ${err.message}`, 'error');
    }
  }, [file, params, addLog]);

  // Launch Taxonium viewer
  const handleLaunch = useCallback(() => {
    if (onLaunchTaxonium) {
      onLaunchTaxonium(outputFile);
    }
  }, [onLaunchTaxonium, outputFile]);

  // Use sample data
  const useSampleData = useCallback(async () => {
    setError(null);
    setLogs([]);
    addLog('Using sample data...');
    
    try {
      setStage(STAGES.LOADING);
      setProgress(50);
      
      // Check if backend is ready with sample data
      const response = await fetch('http://localhost:8001/config');
      if (response.ok) {
        setProgress(100);
        setStage(STAGES.COMPLETE);
        addLog('Sample data loaded!', 'success');
        setOutputFile('sample');
      } else {
        throw new Error('Backend not ready');
      }
    } catch (err) {
      setStage(STAGES.ERROR);
      setError(err.message);
      addLog(`Error: ${err.message}`, 'error');
    }
  }, [addLog]);

  const isRunning = stage !== STAGES.IDLE && stage !== STAGES.COMPLETE && stage !== STAGES.ERROR;
  const canRun = file && !isRunning;
  const canLaunch = stage === STAGES.COMPLETE;

  return (
    <div className="launcher-container">
      <style>{`
        .launcher-container {
          min-height: 100vh;
          background: #f8fafc;
          color: #334155;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
          padding: 2rem;
          display: flex;
          flex-direction: column;
          align-items: center;
        }

        .launcher-card {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 2rem;
          max-width: 640px;
          width: 100%;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }

        .launcher-header {
          margin-bottom: 1.5rem;
          padding-bottom: 1rem;
          border-bottom: 1px solid #e2e8f0;
        }

        .launcher-title {
          font-size: 1.5rem;
          font-weight: 600;
          color: #1e293b;
          margin: 0 0 0.25rem 0;
        }

        .launcher-subtitle {
          color: #64748b;
          font-size: 0.875rem;
          margin: 0;
        }

        .drop-zone {
          border: 1px dashed #cbd5e1;
          border-radius: 6px;
          padding: 2rem;
          text-align: center;
          cursor: pointer;
          transition: all 0.15s ease;
          background: #fafafa;
          margin-bottom: 1.5rem;
        }

        .drop-zone:hover, .drop-zone.dragging {
          border-color: #3b82f6;
          background: #f0f9ff;
        }

        .drop-zone.has-file {
          border-color: #22c55e;
          border-style: solid;
          background: #f0fdf4;
        }

        .drop-icon {
          font-size: 2rem;
          margin-bottom: 0.5rem;
          opacity: 0.7;
        }

        .drop-text {
          font-size: 0.95rem;
          color: #475569;
          margin-bottom: 0.25rem;
        }

        .drop-hint {
          color: #94a3b8;
          font-size: 0.8rem;
        }

        .file-info {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          justify-content: center;
        }

        .file-name {
          font-weight: 500;
          color: #16a34a;
        }

        .file-size {
          color: #64748b;
          font-size: 0.8rem;
        }

        .section-title {
          font-size: 0.75rem;
          font-weight: 600;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 0.75rem;
        }

        .params-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 1rem;
          margin-bottom: 1rem;
        }

        .param-group {
          display: flex;
          flex-direction: column;
          gap: 0.375rem;
        }

        .param-label {
          font-size: 0.8rem;
          color: #475569;
          display: flex;
          align-items: center;
          gap: 0.375rem;
        }

        .param-input {
          background: #ffffff;
          border: 1px solid #d1d5db;
          border-radius: 4px;
          padding: 0.5rem 0.75rem;
          color: #1e293b;
          font-size: 0.875rem;
          transition: border-color 0.15s;
        }

        .param-input:focus {
          outline: none;
          border-color: #3b82f6;
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
        }

        .param-input:disabled {
          background: #f1f5f9;
          color: #94a3b8;
          cursor: not-allowed;
        }

        .checkbox-group {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem 0;
        }

        .checkbox-input {
          width: 1rem;
          height: 1rem;
          accent-color: #3b82f6;
          cursor: pointer;
        }

        .advanced-toggle {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          color: #64748b;
          font-size: 0.8rem;
          cursor: pointer;
          margin-bottom: 1rem;
          transition: color 0.15s;
        }

        .advanced-toggle:hover {
          color: #3b82f6;
        }

        .advanced-section {
          padding: 1rem;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          margin-bottom: 1rem;
        }

        .button-row {
          display: flex;
          gap: 0.75rem;
          margin-bottom: 1rem;
        }

        .btn {
          flex: 1;
          padding: 0.625rem 1rem;
          border-radius: 6px;
          font-size: 0.875rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
          border: none;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
        }

        .btn-primary {
          background: #3b82f6;
          color: white;
        }

        .btn-primary:hover:not(:disabled) {
          background: #2563eb;
        }

        .btn-primary:disabled {
          background: #94a3b8;
          cursor: not-allowed;
        }

        .btn-secondary {
          background: #ffffff;
          color: #475569;
          border: 1px solid #d1d5db;
        }

        .btn-secondary:hover:not(:disabled) {
          background: #f8fafc;
          border-color: #9ca3af;
        }

        .btn-success {
          background: #22c55e;
          color: white;
        }

        .btn-success:hover {
          background: #16a34a;
        }

        .progress-section {
          margin-bottom: 1rem;
          padding: 1rem;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
        }

        .progress-bar-container {
          background: #e2e8f0;
          border-radius: 4px;
          height: 6px;
          overflow: hidden;
          margin-bottom: 0.5rem;
        }

        .progress-bar {
          height: 100%;
          background: #3b82f6;
          border-radius: 4px;
          transition: width 0.3s ease;
        }

        .progress-status {
          display: flex;
          justify-content: space-between;
          font-size: 0.8rem;
        }

        .progress-stage {
          color: #64748b;
        }

        .progress-percent {
          color: #3b82f6;
          font-weight: 500;
        }

        .logs-container {
          background: #1e293b;
          border-radius: 6px;
          padding: 0.75rem 1rem;
          max-height: 180px;
          overflow-y: auto;
          font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
          font-size: 0.75rem;
        }

        .log-entry {
          display: flex;
          gap: 0.5rem;
          padding: 0.125rem 0;
        }

        .log-time {
          color: #64748b;
          flex-shrink: 0;
        }

        .log-message {
          color: #cbd5e1;
        }

        .log-message.success {
          color: #4ade80;
        }

        .log-message.error {
          color: #f87171;
        }

        .error-banner {
          background: #fef2f2;
          border: 1px solid #fecaca;
          border-radius: 6px;
          padding: 0.75rem 1rem;
          color: #dc2626;
          font-size: 0.875rem;
          margin-bottom: 1rem;
        }

        .or-divider {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          margin: 1rem 0;
          color: #94a3b8;
          font-size: 0.8rem;
        }

        .or-divider::before,
        .or-divider::after {
          content: '';
          flex: 1;
          height: 1px;
          background: #e2e8f0;
        }

        .sample-btn {
          width: 100%;
          padding: 0.625rem;
          background: transparent;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          color: #64748b;
          font-size: 0.8rem;
          cursor: pointer;
          transition: all 0.15s;
        }

        .sample-btn:hover {
          background: #f8fafc;
          border-color: #cbd5e1;
          color: #475569;
        }

        .spinner {
          width: 1rem;
          height: 1rem;
          border: 2px solid rgba(255, 255, 255, 0.3);
          border-top-color: white;
          border-radius: 50%;
          animation: spin 0.6s linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        .tooltip {
          position: relative;
          cursor: help;
          color: #94a3b8;
        }

        .tooltip::after {
          content: attr(data-tooltip);
          position: absolute;
          bottom: 100%;
          left: 50%;
          transform: translateX(-50%);
          background: #1e293b;
          color: #e2e8f0;
          padding: 0.375rem 0.625rem;
          border-radius: 4px;
          font-size: 0.7rem;
          white-space: nowrap;
          opacity: 0;
          visibility: hidden;
          transition: all 0.15s;
          z-index: 100;
          margin-bottom: 4px;
        }

        .tooltip:hover::after {
          opacity: 1;
          visibility: visible;
        }
      `}</style>

      <div className="launcher-card">
        <header className="launcher-header">
          <h1 className="launcher-title">Lineage Curation</h1>
          <p className="launcher-subtitle">
            Upload a protobuf tree, configure parameters, and launch the viewer
          </p>
        </header>

        {/* File Drop Zone */}
        <div
          className={`drop-zone ${isDragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pb,.pb.gz"
            onChange={handleFileChange}
            style={{ display: 'none' }}
            disabled={isRunning}
          />
          {file ? (
            <div className="file-info">
              <div>
                <div className="file-name">{file.name}</div>
                <div className="file-size">{(file.size / 1024 / 1024).toFixed(2)} MB</div>
              </div>
            </div>
          ) : (
            <>
              <div className="drop-icon">↑</div>
              <div className="drop-text">Drop .pb file here or click to browse</div>
              <div className="drop-hint">Protobuf phylogenetic tree file</div>
            </>
          )}
        </div>

        {/* Parameters Section */}
        <div className="section-title">Parameters</div>
        <div className="params-grid">
          <div className="param-group">
            <label className="param-label">
              Min Samples
              <span className="tooltip" data-tooltip="Minimum samples per lineage">ⓘ</span>
            </label>
            <input
              type="number"
              className="param-input"
              value={params.minsamples}
              onChange={(e) => updateParam('minsamples', parseInt(e.target.value) || 0)}
              disabled={isRunning}
              min={1}
            />
          </div>
          <div className="param-group">
            <label className="param-label">
              Distinction
              <span className="tooltip" data-tooltip="Min mutations from parent">ⓘ</span>
            </label>
            <input
              type="number"
              className="param-input"
              value={params.distinction}
              onChange={(e) => updateParam('distinction', parseInt(e.target.value) || 0)}
              disabled={isRunning}
              min={0}
            />
          </div>
          <div className="param-group checkbox-group">
            <input
              type="checkbox"
              className="checkbox-input"
              checked={params.recursive}
              onChange={(e) => updateParam('recursive', e.target.checked)}
              disabled={isRunning}
              id="recursive"
            />
            <label htmlFor="recursive" className="param-label" style={{ margin: 0 }}>
              Recursive
              <span className="tooltip" data-tooltip="Add sublineages to new lineages">ⓘ</span>
            </label>
          </div>
          <div className="param-group checkbox-group">
            <input
              type="checkbox"
              className="checkbox-input"
              checked={params.verbose}
              onChange={(e) => updateParam('verbose', e.target.checked)}
              disabled={isRunning}
              id="verbose"
            />
            <label htmlFor="verbose" className="param-label" style={{ margin: 0 }}>
              Verbose Output
            </label>
          </div>
        </div>

        {/* Advanced Options */}
        <div 
          className="advanced-toggle"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          <span>{showAdvanced ? '▼' : '▶'}</span>
          <span>Advanced Options</span>
        </div>

        {showAdvanced && (
          <div className="advanced-section">
            <div className="params-grid">
              <div className="param-group">
                <label className="param-label">
                  Cutoff
                  <span className="tooltip" data-tooltip="Stop when this proportion covered">ⓘ</span>
                </label>
                <input
                  type="number"
                  className="param-input"
                  value={params.cutoff}
                  onChange={(e) => updateParam('cutoff', parseFloat(e.target.value) || 0)}
                  disabled={isRunning}
                  min={0}
                  max={1}
                  step={0.05}
                />
              </div>
              <div className="param-group">
                <label className="param-label">
                  Floor
                  <span className="tooltip" data-tooltip="Minimum score to report">ⓘ</span>
                </label>
                <input
                  type="number"
                  className="param-input"
                  value={params.floor}
                  onChange={(e) => updateParam('floor', parseFloat(e.target.value) || 0)}
                  disabled={isRunning}
                  min={0}
                  step={0.1}
                />
              </div>
              <div className="param-group checkbox-group">
                <input
                  type="checkbox"
                  className="checkbox-input"
                  checked={params.clear}
                  onChange={(e) => updateParam('clear', e.target.checked)}
                  disabled={isRunning}
                  id="clear"
                />
                <label htmlFor="clear" className="param-label" style={{ margin: 0 }}>
                  Clear existing annotations
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Error Banner */}
        {error && (
          <div className="error-banner">
            <strong>Error:</strong> {error}
          </div>
        )}

        {/* Progress Section */}
        {stage !== STAGES.IDLE && (
          <div className="progress-section">
            <div className="progress-bar-container">
              <div className="progress-bar" style={{ width: `${progress}%` }} />
            </div>
            <div className="progress-status">
              <span className="progress-stage">{STAGE_LABELS[stage]}</span>
              <span className="progress-percent">{progress}%</span>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="button-row">
          {canLaunch ? (
            <button className="btn btn-success" onClick={handleLaunch}>
              Launch Viewer
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={runPipeline}
              disabled={!canRun}
            >
              {isRunning ? (
                <>
                  <div className="spinner" />
                  Processing...
                </>
              ) : (
                <>Run Pipeline</>
              )}
            </button>
          )}
          {file && !isRunning && stage !== STAGES.COMPLETE && (
            <button
              className="btn btn-secondary"
              onClick={() => {
                setFile(null);
                setStage(STAGES.IDLE);
                setLogs([]);
                setError(null);
              }}
            >
              Clear
            </button>
          )}
        </div>

        {/* Logs */}
        {logs.length > 0 && (
          <>
            <div className="section-title">Logs</div>
            <div className="logs-container" ref={logsRef}>
              {logs.map((log, i) => (
                <div key={i} className="log-entry">
                  <span className="log-time">{log.timestamp}</span>
                  <span className={`log-message ${log.type}`}>{log.message}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Or use sample data */}
        {stage === STAGES.IDLE && !file && (
          <>
            <div className="or-divider">or</div>
            <button className="sample-btn" onClick={useSampleData}>
              Use sample data to explore the interface
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default LauncherApp;
