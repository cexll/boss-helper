import type { LogLevel } from 'devlog-ui'
import { logger, LogPersistence } from 'devlog-ui'

LogPersistence.enable({
  storage: 'session', // 'session' (sessionStorage) or 'local' (localStorage)
  maxPersisted: 500, // Max logs to persist
  debounceMs: 100, // Debounce writes for performance
})

let level: string = 'warn'

if (
  'localStorage' in window &&
  typeof localStorage !== 'undefined' &&
  typeof localStorage.getItem === 'function'
) {
  level = localStorage.getItem('__BH_LOG_LEVEL__') ?? level
}

logger.configure({
  maxLogs: 1000, // Max logs in memory (FIFO rotation)
  minLevel: level as LogLevel, // Minimum level: 'debug' | 'info' | 'warn' | 'error'
  enabled: true, // Enable/disable logging
  shortcutAction: 'toggle', // Ctrl+Shift+L: 'toggle' | 'popout'
  showToggleButton: true, // Show the floating toggle button
  spanCollapsed: false, // Collapse span groups by default
})

export { logger }
