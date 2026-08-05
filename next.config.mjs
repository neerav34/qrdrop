/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // strict-mode double-mount would tear down live RTCPeerConnections
};

export default nextConfig;
