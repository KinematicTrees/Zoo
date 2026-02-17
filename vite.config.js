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
  },

  // Keep preview aligned too (optional but convenient).
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
};
