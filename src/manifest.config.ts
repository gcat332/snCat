import { defineManifest } from '@crxjs/vite-plugin'
import pkg from '../package.json'

/**
 * MV3 manifest for the ServiceNow Java Assistant (snJava).
 *
 * Host strategy (handoff §7 decision 3): match all standard ServiceNow
 * instances so the extension reads whatever instance the user is on from the
 * active tab. Vanity-domain instances are handled later via
 * optional_host_permissions requested on demand.
 */
export default defineManifest({
  manifest_version: 3,
  name: 'snJava — ServiceNow Java Assistant',
  version: pkg.version || '0.0.0',
  description: pkg.description,

  minimum_chrome_version: '116', // Side Panel API

  action: {
    default_title: 'Open snJava',
    default_icon: {
      '16': 'public/icons/icon-16.png',
      '32': 'public/icons/icon-32.png',
      '48': 'public/icons/icon-48.png',
      '128': 'public/icons/icon-128.png',
    },
  },

  icons: {
    '16': 'public/icons/icon-16.png',
    '32': 'public/icons/icon-32.png',
    '48': 'public/icons/icon-48.png',
    '128': 'public/icons/icon-128.png',
  },

  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },

  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },

  // Layer 2 sandbox: user scripts run here (opaque origin) where eval/new
  // Function are allowed but chrome.* and cookies are not (no allow-same-origin).
  sandbox: {
    pages: ['public/sandbox/index.html'],
  },

  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
    sandbox:
      "sandbox allow-scripts; script-src 'self' 'unsafe-inline' 'unsafe-eval'; object-src 'self'",
  },

  permissions: ['sidePanel', 'tabs', 'scripting', 'storage'],

  host_permissions: [
    'https://*.service-now.com/*',
    'https://dev-agenthub.mfec.co.th/*', // MFEC AgentHub LLM endpoint
  ],

  content_scripts: [
    {
      matches: ['https://*.service-now.com/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: true,
    },
    {
      // MAIN-world bridge: reads window.g_form / window.g_ck on classic UI and
      // relays them to the isolated content script via window.postMessage.
      matches: ['https://*.service-now.com/*'],
      js: ['src/content/mainworld.ts'],
      run_at: 'document_idle',
      world: 'MAIN',
      all_frames: false,
    },
  ],

  optional_host_permissions: ['https://*/*'],
})
