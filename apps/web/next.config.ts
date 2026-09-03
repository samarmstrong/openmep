import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@mep/model-core"],
  serverExternalPackages: ["web-ifc"],
  typedRoutes: true
};

export default nextConfig;
