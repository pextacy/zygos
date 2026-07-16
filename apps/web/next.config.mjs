/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Only NEXT_PUBLIC_SERVER_WS_URL and NEXT_PUBLIC_CLUSTER reach the browser
  // (CLAUDE.md §9). TxLINE credentials never enter this app.
};

export default nextConfig;
