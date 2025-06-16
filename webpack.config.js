const path = require('path');

module.exports = {
  entry: './src/index.ts', // Replace with the path to your entry file
  mode: 'development',
  output: {
    path: path.resolve(__dirname, 'dist'), // Output directory for bundled JavaScript
    filename: 'index.js', // Output filename
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'], // Add .ts extension for TypeScript files
  },
};