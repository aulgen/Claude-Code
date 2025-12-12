#!/usr/bin/env npx ts-node
/**
 * Test script to diagnose web search issues
 * Run with: npx ts-node src/test-websearch.ts
 */

import axios from 'axios';
import * as cheerio from 'cheerio';

const testQuery = 'types of pathologist';
const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(testQuery)}`;

console.log('=== Web Search Diagnostic Test ===\n');
console.log(`Testing URL: ${url}\n`);

async function testSearch() {
  try {
    console.log('Making request to DuckDuckGo...');

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
      },
      timeout: 15000,
    });

    console.log(`\n✓ Response Status: ${response.status}`);
    console.log(`✓ HTML Length: ${response.data?.length || 0} bytes`);

    const html = response.data || '';
    const $ = cheerio.load(html);

    // Check for blocking
    const htmlLower = html.toLowerCase();
    if (htmlLower.includes('captcha')) {
      console.log('\n⚠️  WARNING: Response contains "captcha" - DuckDuckGo may be blocking requests');
    }
    if (htmlLower.includes('robot')) {
      console.log('\n⚠️  WARNING: Response contains "robot" - Bot detection may be active');
    }
    if (htmlLower.includes('blocked')) {
      console.log('\n⚠️  WARNING: Response contains "blocked"');
    }

    // Check for various selectors
    console.log('\n=== HTML Structure Analysis ===');
    console.log(`  .result elements: ${$('.result').length}`);
    console.log(`  .result__a elements: ${$('.result__a').length}`);
    console.log(`  .result__title elements: ${$('.result__title').length}`);
    console.log(`  .result__snippet elements: ${$('.result__snippet').length}`);
    console.log(`  .results_links elements: ${$('.results_links').length}`);
    console.log(`  .web-result elements: ${$('.web-result').length}`);
    console.log(`  a[href] elements: ${$('a[href]').length}`);

    // Print page title
    console.log(`\n  Page title: "${$('title').text().trim()}"`);

    // Try to extract some results
    const results: { title: string; snippet: string }[] = [];

    $('.result').each((i, el) => {
      if (i >= 3) return; // Limit to 3 for display
      const title = $(el).find('.result__title a, .result__a').text().trim();
      const snippet = $(el).find('.result__snippet').text().trim();
      if (title) {
        results.push({ title, snippet: snippet.substring(0, 100) });
      }
    });

    if (results.length > 0) {
      console.log('\n=== Sample Results Found ===');
      results.forEach((r, i) => {
        console.log(`\n${i + 1}. ${r.title}`);
        console.log(`   ${r.snippet}...`);
      });
    } else {
      console.log('\n❌ No results found with standard selectors');
      console.log('\n=== First 1000 chars of HTML ===');
      console.log(html.substring(0, 1000));
    }

    // Check if it's a different page type
    if (html.includes('no results') || html.includes('No results')) {
      console.log('\n⚠️  The page indicates "no results" - try a different query');
    }

  } catch (error) {
    console.log('\n❌ Request failed:');
    if (axios.isAxiosError(error)) {
      console.log(`   Status: ${error.response?.status}`);
      console.log(`   Message: ${error.message}`);
      if (error.response?.headers) {
        console.log(`   Headers:`, error.response.headers);
      }
    } else {
      console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

testSearch();
