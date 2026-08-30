/** @type {import('next').NextConfig} */
const nextConfig = {
  compiler: { styledComponents: true },
  transpilePackages: ["@razorpay/blade"],
};

module.exports = nextConfig;
