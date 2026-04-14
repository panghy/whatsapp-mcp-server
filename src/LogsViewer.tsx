import { useState, useEffect, useRef, useCallback } from 'react'

interface LogEntry {
  id: number
  timestamp: string
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  category: string
  message: string
  details_json: any
}

const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR']
const LOG_CATEGORIES = ['connection', 'sync', 'api', 'transformer', 'error', 'group-metadata']

export default function LogsViewer() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [selectedLevels, setSelectedLevels] = useState<Set<string>>(new Set(LOG_LEVELS))
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set(LOG_CATEGORIES))
  const [searchText, setSearchText] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const autoRefreshIntervalRef = useRef<NodeJS.Timeout | null>(null)

  const loadLogs = useCallback(async () => {
    try {
      setLoading(true); setError(null)
      const logsData = await window.electron.getLogs({ levels: Array.from(selectedLevels), categories: Array.from(selectedCategories), searchText: searchText || undefined, limit: 1000 })
      setLogs(logsData)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load logs'
      setError(msg); console.error('Failed to load logs:', err)
    } finally { setLoading(false) }
  }, [selectedLevels, selectedCategories, searchText])

  useEffect(() => { loadLogs() }, [loadLogs])

  useEffect(() => {
    if (autoRefresh) {
      autoRefreshIntervalRef.current = setInterval(loadLogs, 2000)
      return () => { if (autoRefreshIntervalRef.current) { clearInterval(autoRefreshIntervalRef.current) } }
    }
  }, [autoRefresh, loadLogs])

  const handleLevelToggle = (level: string) => {
    const newLevels = new Set(selectedLevels)
    if (newLevels.has(level)) { newLevels.delete(level) } else { newLevels.add(level) }
    setSelectedLevels(newLevels)
  }

  const handleCategoryToggle = (category: string) => {
    const newCategories = new Set(selectedCategories)
    if (newCategories.has(category)) { newCategories.delete(category) } else { newCategories.add(category) }
    setSelectedCategories(newCategories)
  }

  const handleClearLogs = async () => {
    if (window.confirm('Are you sure you want to clear all logs? This action cannot be undone.')) {
      try { await window.electron.clearLogs(); setLogs([]); setError(null) }
      catch (err) { setError(err instanceof Error ? err.message : 'Failed to clear logs') }
    }
  }

  const handleExportLogs = async (format: 'json' | 'text') => {
    try {
      const success = await window.electron.exportLogs(format)
      if (success) { alert(`Logs exported successfully as ${format.toUpperCase()}`) }
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to export logs') }
  }

  const getLevelColor = (level: string): string => {
    switch (level) {
      case 'ERROR': return '#ef4444'
      case 'WARN': return '#f59e0b'
      case 'INFO': return '#3b82f6'
      case 'DEBUG': return '#9ca3af'
      default: return '#6b7280'
    }
  }

  return (
    <div className="logs-viewer">
      <div className="logs-header">
        <h3>Application Logs</h3>
        <div className="logs-controls">
          <label className="checkbox-label"><input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} /><span>Auto-refresh</span></label>
          <button className="logs-btn" onClick={() => loadLogs()}>Refresh</button>
          <button className="logs-btn" onClick={() => handleExportLogs('json')}>Export JSON</button>
          <button className="logs-btn" onClick={() => handleExportLogs('text')}>Export Text</button>
          <button className="logs-btn danger" onClick={handleClearLogs}>Clear Logs</button>
        </div>
      </div>

      {error && (<div className="error-message"><p>{error}</p></div>)}

      <div className="logs-filters">
        <div className="filter-group">
          <label className="filter-label">Levels:</label>
          <div className="filter-options">
            {LOG_LEVELS.map(level => (<label key={level} className="checkbox-label"><input type="checkbox" checked={selectedLevels.has(level)} onChange={() => handleLevelToggle(level)} /><span>{level}</span></label>))}
          </div>
        </div>
        <div className="filter-group">
          <label className="filter-label">Categories:</label>
          <div className="filter-options">
            {LOG_CATEGORIES.map(category => (<label key={category} className="checkbox-label"><input type="checkbox" checked={selectedCategories.has(category)} onChange={() => handleCategoryToggle(category)} /><span>{category}</span></label>))}
          </div>
        </div>
        <div className="filter-group">
          <label className="filter-label">Search:</label>
          <input type="text" className="search-input" placeholder="Search logs..." value={searchText} onChange={(e) => setSearchText(e.target.value)} />
        </div>
      </div>

      <div className="logs-container" ref={scrollContainerRef}>
        {loading ? (<p className="logs-loading">Loading logs...</p>) : logs.length === 0 ? (<p className="logs-empty">No logs found</p>) : (
          <div className="logs-list">
            {logs.map(log => (
              <div key={log.id} className="log-entry">
                <div className="log-level" style={{ backgroundColor: getLevelColor(log.level) }}>{log.level}</div>
                <div className="log-content">
                  <div className="log-header">
                    <span className="log-timestamp">{new Date(log.timestamp).toLocaleString()}</span>
                    <span className="log-category">[{log.category}]</span>
                  </div>
                  <div className="log-message">{log.message}</div>
                  {log.details_json && (<div className="log-details">{JSON.stringify(log.details_json, null, 2)}</div>)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

