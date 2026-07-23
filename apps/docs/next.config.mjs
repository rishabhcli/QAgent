import { fileURLToPath } from 'node:url';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  basePath,
  assetPrefix: basePath || undefined,
  images: { unoptimized: true },
  reactStrictMode: true,
  turbopack: { root: fileURLToPath(new URL('../..', import.meta.url)) },
};

export default nextConfig;
