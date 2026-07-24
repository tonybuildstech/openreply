import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Emit a self-contained server (.next/standalone/server.js + traced
  // node_modules) so the VPS runs the build artifact without the source tree
  // or dev dependencies. See deploy/ and .github/workflows/deploy.yml.
  output: "standalone",
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
