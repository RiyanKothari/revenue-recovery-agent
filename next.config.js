/** @type {import('next').NextConfig} */
const nextConfig = {
  compiler: { styledComponents: true },
  transpilePackages: ["@razorpay/blade"],

  experimental: {
    /**
     * Keep the database drivers out of the webpack bundle.
     *
     * `pg` and `mysql2` are native Node packages that resolve dialects and
     * bindings through dynamic requires. Bundling them makes the containing
     * module fail to evaluate, and Next reports the symptom rather than the
     * cause: "No HTTP methods exported" on every route, because the route
     * module never finished loading. Marking them external leaves them to
     * Node's own require at runtime, which is what they expect.
     */
    serverComponentsExternalPackages: ["pg", "mysql2"],
  },
};

module.exports = nextConfig;
