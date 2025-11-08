#!/usr/bin/env node

/**
 * arena-chan-dl
 * Download contents of an Are.na channel
 * Modernized for Node.js 18+
 */

import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import axios from 'axios';
import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import updateNotifier from 'update-notifier';
import { extension } from 'mime-types';
import slugify from 'slugify';

// Load package.json for update notifier
const require = createRequire(import.meta.url);
const pkg = require('./package.json');

// Configuration
const PER_PAGE = 100;
const USER_AGENT = `${pkg.name}/${pkg.version} (https://github.com/yourusername/${pkg.name})`;

// Configure axios
axios.defaults.headers['User-Agent'] = USER_AGENT;
axios.defaults.timeout = 30000;

// Check for updates weekly
updateNotifier({ pkg, updateCheckInterval: 1000 * 60 * 60 * 24 * 7 }).notify();

/**
 * Create a client for interacting with Are.na API
 */
function createChannelClient(slug) {
  return {
    async getThumb() {
      const response = await axios.get(`https://api.are.na/v2/channels/${slug}/thumb`);
      return response.data;
    },

    async getPage(page, per) {
      console.log(chalk.blue(`Fetching page ${page}...`));
      try {
        const response = await axios.get(
          `https://api.are.na/v2/channels/${slug}/contents?page=${page}&per=${per}`
        );
        return response.data;
      } catch (error) {
        console.error(chalk.red(`Failed to fetch page ${page}: ${error.message}`));
        throw error;
      }
    }
  };
}

/**
 * Download a single block/image from a channel
 */
async function downloadBlock(block, options) {
  const { slug, outputDir, index } = options;

  console.log(chalk.cyan(`Download #${index}: Block ${block.id}`));

  // Skip blocks without images
  if (!block.image?.original?.url) {
    console.log(chalk.yellow(`  → Skipped: no image`));
    return { success: false, reason: 'no-image' };
  }

  const imageUrl = block.image.original.url;
  console.log(chalk.grey(`  → ${imageUrl}`));

  try {
    // Ensure channel directory exists
    const channelDir = path.join(outputDir, slug);
    await fs.mkdir(channelDir, { recursive: true });

    // Download image
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer'
    });

    // Generate filename
    const title = block.title ? slugify(block.title, {
      lower: true,
      strict: true,
      trim: true
    }) : block.id;

    const ext = extension(block.image.content_type) || 'bin';
    const filename = `${block.id}_${title}.${ext}`;
    const filepath = path.join(channelDir, filename);

    await fs.writeFile(filepath, response.data);
    console.log(chalk.grey(`  ✓ ${filename}`));

    return { success: true, filepath };
  } catch (error) {
    console.error(chalk.red(`  ✗ Failed: ${error.message}`));
    return { success: false, reason: error.message };
  }
}

/**
 * Main function to download an entire channel
 */
async function downloadChannel(slug, outputDir, chunkSize) {
  // Validate inputs
  if (!slug || typeof slug !== 'string') {
    throw new Error('Valid channel slug is required');
  }

  if (chunkSize < 1 || chunkSize > 50) {
    throw new Error('Chunk size must be between 1 and 50');
  }

  // Resolve absolute output directory
  const resolvedOutputDir = path.resolve(outputDir);

  const client = createChannelClient(slug);

  console.log(chalk.blue(`\n📦 Fetching channel: ${slug}`));

  try {
    // Get channel metadata
    const { title, length } = await client.getThumb();
    console.log(chalk.green(`✓ Channel "${title}" has ${length} blocks\n`));

    // Handle empty channel
    if (length === 0) {
      console.log(chalk.yellow('Channel is empty, nothing to download'));
      return;
    }

    // Calculate total pages needed
    const totalPages = Math.ceil(length / PER_PAGE);

    // Fetch all pages in parallel
    const pagePromises = Array.from({ length: totalPages }, (_, i) =>
    client.getPage(i + 1, PER_PAGE)
    );

    const pages = await Promise.all(pagePromises);
    const allContents = pages.flatMap(page => page.contents);

    console.log(chalk.blue(`⬇️  Downloading ${allContents.length} blocks in chunks of ${chunkSize}...\n`));

    // Download blocks in chunks
    let downloaded = 0;
    let failed = 0;

    for (let i = 0; i < allContents.length; i += chunkSize) {
      const chunk = allContents.slice(i, i + chunkSize);
      const results = await Promise.allSettled(
        chunk.map((block, idx) =>
        downloadBlock(block, {
          slug,
          outputDir: resolvedOutputDir,
          index: i + idx + 1
        })
        )
      );

      // Count results
      results.forEach(result => {
        if (result.status === 'fulfilled' && result.value.success) {
          downloaded++;
        } else {
          failed++;
        }
      });

      // Progress summary for this chunk
      const progress = chalk.blue(`Progress: ${downloaded}/${allContents.length} downloaded`);
      const failures = failed > 0 ? chalk.red(`(${failed} failed)`) : '';
      console.log(`${progress} ${failures}\n`);
    }

    // Final summary
    console.log(chalk.green.bold(`✅ Done! Downloaded: ${downloaded}, Failed: ${failed}`));
  } catch (error) {
    console.error(chalk.red.bold(`\n❌ Fatal error: ${error.message}`));
    throw error;
  }
}

// CLI setup and parsing
yargs(hideBin(process.argv))
.scriptName('arena-chan-dl')
.usage('$0 <cmd> [options]')
.command(
  'get <slug>',
  'download contents of an are.na channel',
  (yargs) => {
    return yargs
    .positional('slug', {
      type: 'string',
      describe: 'slug of the channel to download'
    })
    .option('output', {
      alias: 'o',
      type: 'string',
      default: '.',
        describe: 'output directory'
    })
    .option('chunk-size', {
      alias: 'c',
      type: 'number',
      default: 10,
        describe: 'number of images to download simultaneously'
    });
  },
  async (argv) => {
    try {
      await downloadChannel(argv.slug, argv.output, argv.chunkSize);
    } catch (error) {
      process.exit(1);
    }
  }
)
.example('$0 get frog', 'download specific are.na channel')
.example('$0 get frog -o ./downloads', 'download to specific directory')
.example('$0 get frog -c 20', 'download with larger chunk size')
.help()
.alias('h', 'help')
.alias('v', 'version')
.version(pkg.version)
.parse();
