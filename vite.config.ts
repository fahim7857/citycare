import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    // Must match the BASE_PATH constant in server.ts and cPanel's
    // "Application URL" setting. Needed because this app is served from
    // renbora.com/citycare/ instead of the domain root — without this,
    // built asset paths (JS/CSS) resolve from "/" instead of "/citycare/"
    // and fail to load.
    base: '/citycare/',
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        // Vite only builds index.html by default. These extra static pages
        // (operator upload form, patient report viewer) need to be listed
        // explicitly or they simply won't exist in dist/ after `npm run build`.
        input: {
          main: path.resolve(__dirname, 'index.html'),
          doctors: path.resolve(__dirname, 'doctors.html'),
          appointment: path.resolve(__dirname, 'appointment.html'),
          appointmentHistory: path.resolve(__dirname, 'appointment-history.html'),
          reports: path.resolve(__dirname, 'reports.html'),
          contact: path.resolve(__dirname, 'contact.html'),
          receipt: path.resolve(__dirname, 'receipt.html'),
          adminUpload: path.resolve(__dirname, 'admin-upload.html'),
          adminLogin: path.resolve(__dirname, 'admin-login.html'),
          adminDashboard: path.resolve(__dirname, 'admin-dashboard.html'),
          reportView: path.resolve(__dirname, 'report-view.html'),
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});