import path from 'path';
import { fileURLToPath } from 'url';
import webpack from 'webpack';
import CopyWebpackPlugin from 'copy-webpack-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  mode: 'development',
  entry: {
    'content': './src/content/main.js',
    'service-worker': './src/background/service-worker.js',
    'popup': './popup/popup.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist-test'),
    filename: '[name].js',
    clean: true
  },
  module: {
    rules: []
  },
  resolve: {
    extensions: ['.js']
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify('test'),
      '__GMAIL_API_BASE__': JSON.stringify('http://localhost:4001/gmail/v1'),
      '__GMAIL_UPLOAD_BASE__': JSON.stringify('http://localhost:4001/upload/gmail/v1'),
      '__SKIP_OAUTH__': JSON.stringify(true),
      // Skip InboxSDK.load() — tests run on localhost:4001, not Gmail
      '__SKIP_INBOXSDK__': JSON.stringify(true),
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'manifest.test.json', to: 'manifest.json' },
        { from: 'popup/popup.html', to: 'popup.html' },
        { from: 'assets/icons', to: 'icons' },
        { from: 'node_modules/@inboxsdk/core/pageWorld.js', to: 'pageWorld.js' }
      ]
    })
  ],
  optimization: {
    nodeEnv: false,   // Let our DefinePlugin control process.env.NODE_ENV = 'test'
    splitChunks: false,
    runtimeChunk: false
  },
  target: ['web', 'es2020'],
  devtool: 'source-map'  // Enable sourcemaps for debugging
};
