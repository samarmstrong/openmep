import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@openmep/model-core"],
  serverExternalPackages: ["web-ifc"],
  typedRoutes: true
};

export default nextConfig;
