import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({ base: './', plugins: [svelte()], build: {
  rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'genlayer', test: /node_modules\/(genlayer-js|viem|ox)\// }] } } },
} });
