import React, { useState, useEffect, Suspense, lazy } from 'react';
import LauncherApp from './LauncherApp';

const Taxonium = lazy(() => import('taxonium-component'));

// Loading screen component
function LoadingScreen({ message, progress }) {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#f8fafc',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#334155',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif"
    }}>
      <div style={{
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: '8px',
        padding: '2.5rem',
        textAlign: 'center',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)'
      }}>
        <div style={{
          width: '40px',
          height: '40px',
          border: '3px solid #e2e8f0',
          borderTopColor: '#3b82f6',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
          margin: '0 auto 1.25rem'
        }} />
        <h2 style={{
          fontSize: '1.125rem',
          fontWeight: 600,
          color: '#1e293b',
          margin: '0 0 0.375rem'
        }}>
          Loading Tree Data
        </h2>
        <p style={{ color: '#64748b', margin: 0, fontSize: '0.875rem' }}>{message || 'Preparing visualization...'}</p>
        {progress !== undefined && (
          <div style={{
            marginTop: '1.25rem',
            background: '#e2e8f0',
            borderRadius: '4px',
            height: '6px',
            width: '200px',
            overflow: 'hidden'
          }}>
            <div style={{
              height: '100%',
              background: '#3b82f6',
              borderRadius: '4px',
              width: `${progress}%`,
              transition: 'width 0.3s ease'
            }} />
          </div>
        )}
      </div>
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

function App() {
  const [view, setView] = useState('launcher'); // 'launcher' or 'taxonium'
  const [backendReady, setBackendReady] = useState(false)
  const [backendError, setBackendError] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadingMessage, setLoadingMessage] = useState('')
  const [outputFile, setOutputFile] = useState(null)
  const [pipelineDownloads, setPipelineDownloads] = useState([])
  
  // Check if backend has loaded data (not just running)
  const checkDataReady = async () => {
    try {
      const response = await fetch('http://localhost:8001/config')
      if (response.ok) {
        const config = await response.json()
        // Check if we have actual nodes loaded
        if (config.num_nodes && config.num_nodes > 0) {
          return true
        }
      }
      return false
    } catch (error) {
      return false
    }
  }

  // Handle launching Taxonium from the launcher
  const handleLaunchTaxonium = async (file) => {
    // Prevent multiple launches
    if (isLoading) return;
    
    setIsLoading(true)
    setBackendError(null)
    setOutputFile(file)
    setLoadingMessage('Starting data reload...')
    
    // If we have a new file (not sample mode), reload and wait
    if (file && file !== 'sample') {
      try {
        setLoadingMessage('Loading tree data...')
        
        const response = await fetch('http://localhost:8001/reload-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataFile: file })
        })
        
        if (!response.ok) {
          const error = await response.json()
          throw new Error(error.error || 'Failed to reload data')
        }
        
        const result = await response.json()
        console.log('Data reloaded:', result.nodes, 'nodes')
        setLoadingMessage(`Loaded ${result.nodes?.toLocaleString() || ''} nodes`)
        
      } catch (error) {
        console.error('Failed to reload data:', error)
        setBackendError(error.message)
        setIsLoading(false)
        return
      }
    }
    
    // Data is ready, switch to Taxonium
    setBackendReady(true)
    setIsLoading(false)
    setView('taxonium')
  }

  // Handle going back to launcher
  const handleBackToLauncher = () => {
    setView('launcher')
    setOutputFile(null)
    setIsLoading(false)
  }

  // Show launcher view
  if (view === 'launcher' && !isLoading) {
    return <LauncherApp onLaunchTaxonium={handleLaunchTaxonium} onDownloadsReady={setPipelineDownloads} />
  }
  
  // Show loading state with nice UI
  if (isLoading) {
    return <LoadingScreen message={loadingMessage} />
  }
  
  // Show error if backend failed
  if (backendError && !backendReady) {
    return (
      <div className="error-container">
        <h2>Backend Server Error</h2>
        <p>{backendError}</p>
        <p>Make sure the backend server is running on port 8001</p>
        <button onClick={handleBackToLauncher} style={{ marginTop: '20px', padding: '10px 20px' }}>
          Back to Launcher
        </button>
      </div>
    )
  }

  // Backend is ready, show Taxonium
  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden">
      {/* Top bar */}
      <div style={{
        background: '#f8fafc',
        borderBottom: '1px solid #e2e8f0',
        padding: '4px 10px',
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
      }}>
        <button
          onClick={handleBackToLauncher}
          style={{
            background: 'transparent',
            color: '#64748b',
            border: 'none',
            cursor: 'pointer',
            fontSize: '13px',
            padding: '2px 6px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          ← Back
        </button>
      </div>
      <div className="h-full" style={{ flex: 1, minHeight: 0 }}>
        <Suspense fallback={<LoadingScreen message="Loading viewer components..." />}>
          <Taxonium
            backendUrl="http://localhost:8001"
            sidePanelHiddenByDefault={false}
            pipelineDownloads={pipelineDownloads}
          />
        </Suspense>
      </div>
    </div>
  )
}

export default App