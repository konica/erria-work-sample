import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Vite defaults to loopback (::1), which is unreachable from outside a container or
    // VM, so the dev server cannot be published to the host. Bind the unspecified
    // address instead. '::' rather than '0.0.0.0': Node opens it dual-stack, so one
    // socket accepts both IPv6 and IPv4-mapped connections and the server is reachable
    // whichever stack the port forward uses. This is what console-api already gets from
    // Nest's default listen().
    host: '::',
    // Requests then arrive with a Host header that is not localhost (a container IP, or
    // whatever name the port forward uses), and Vite rejects unknown hosts by default.
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:3000',
      '/internal': 'http://localhost:3000',
    },
  },
});
