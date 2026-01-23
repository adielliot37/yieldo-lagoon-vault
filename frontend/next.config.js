/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { isServer }) => {
    // Ignore optional dependencies that aren't needed for browser
    config.resolve.fallback = { 
      fs: false, 
      net: false, 
      tls: false,
      crypto: false,
      stream: false,
      url: false,
      zlib: false,
      http: false,
      https: false,
      assert: false,
      os: false,
      path: false,
    };

    // Ignore optional peer dependencies that cause warnings
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        '@react-native-async-storage/async-storage': false,
        'pino-pretty': false,
      };
    }

    // Suppress warnings for optional dependencies
    config.ignoreWarnings = [
      { module: /node_modules\/@metamask\/sdk/ },
      { module: /node_modules\/pino/ },
    ];

    return config;
  },
}

module.exports = nextConfig


