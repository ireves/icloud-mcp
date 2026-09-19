/** @type {import('next').NextConfig} */
const nextConfig = {
  // The mail, calendar and reminder modules were written for Node, where an
  // import has to name the file it wants with a .js ending even though the file
  // on disk is TypeScript. The bundler does not assume that, so it is told
  // here, rather than rewriting every import across the codebase.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },

  // Next.js will not serve a route folder whose name starts with a dot, and the
  // authorization server lives under /api/auth, so the discovery documents are
  // reached through /api/discovery instead. Every spelling a client might try
  // is sent there, and that route asks the server for the right document.
  //
  // Both forms of each path matter: a client reads the issuer out of the
  // protected resource document and then, because that issuer carries a path,
  // looks for its metadata with the path appended.
  //
  // A rewrite does not change the address the handler reads, so each
  // destination restores the real path itself rather than assuming the rewrite
  // did it.
  async rewrites() {
    return [
      {
        source: '/.well-known/oauth-authorization-server',
        destination: '/api/discovery/oauth-authorization-server',
      },
      {
        source: '/.well-known/oauth-authorization-server/:path*',
        destination: '/api/discovery/oauth-authorization-server',
      },
      {
        source: '/.well-known/openid-configuration',
        destination: '/api/discovery/openid-configuration',
      },
      {
        source: '/.well-known/openid-configuration/:path*',
        destination: '/api/discovery/openid-configuration',
      },
      {
        source: '/.well-known/oauth-protected-resource',
        destination: '/api/discovery/oauth-protected-resource',
      },
      {
        source: '/.well-known/oauth-protected-resource/:path*',
        destination: '/api/discovery/oauth-protected-resource',
      },

      // /mcp is the path most people reach for, and leaving off /api is an easy
      // slip that surfaces as an unexplained 404 in the client. The endpoint
      // itself puts the real path back before answering.
      { source: '/mcp', destination: '/api/mcp' },
    ];
  },
};

export default nextConfig;
