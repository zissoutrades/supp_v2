import path from 'path';
import { fileURLToPath } from 'url';
import CopyWebpackPlugin from 'copy-webpack-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  mode: 'production',
  entry: {
    'content': './src/content/main.js',
    'service-worker': './src/background/service-worker.js',
    'popup': './popup/popup.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
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
    new CopyWebpackPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'popup/popup.html', to: 'popup.html' },
        { from: 'assets/icons', to: 'icons' },
        { from: 'node_modules/@inboxsdk/core/pageWorld.js', to: 'pageWorld.js' }
      ]
    })
  ],
  optimization: {
    splitChunks: false,
    runtimeChunk: false
  },
  target: ['web', 'es2020'],
  devtool: false
};
