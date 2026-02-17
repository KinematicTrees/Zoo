/**
 * @type {import('vite').UserConfig}
 */
export default {
  base: process.env.NODE_ENV === 'production' ? '/Zoo/' : '',

  // Serve on all interfaces so other machines can reach it.
  // ("0.0.0.0:5173" / aka "0000:5173")
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,

    // Vite host check (fix "Blocked request. This host (\"phoenix\") is not allowed")
    allowedHosts: ['phoenix', 'localhost', '127.0.0.1', '192.168.0.8', '100.114.94.57'],
  },

  // Keep preview aligned too (optional but convenient).
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['phoenix', 'localhost', '127.0.0.1', '192.168.0.8', '100.114.94.57'],
  },
};
