import type { NextConfig } from 'next';

const staticBuild = process.env.FLOWSTACKS_STATIC_BUILD === 'true';

const config: NextConfig = {
  ...(staticBuild ? { output: 'export' as const, trailingSlash: true } : {}),
  images: { unoptimized: true },
};

export default config;
