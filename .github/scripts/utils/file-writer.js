#!/usr/bin/env node

/**
 * File Writer - Atomic file operations for job data
 *
 * Handles safe writes to prevent corruption if process is killed mid-operation.
 */

const fs = require('fs');
const path = require('path');

/**
 * Write jobs to JSONL file atomically
 * @param {Array} jobs - Array of job objects
 * @param {string} filePath - Output file path
 * @returns {Promise<void>}
 */
async function writeJobsJSONL(jobs, filePath) {
  const dir = path.dirname(filePath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${filePath}.tmp`;

  try {
    // Convert to JSONL (one JSON per line)
    const jsonlContent = jobs.map(job => JSON.stringify(job)).join('\n') + '\n';

    // Write to temp file
    fs.writeFileSync(tempPath, jsonlContent, 'utf8');

    // Atomic rename
    fs.renameSync(tempPath, filePath);

    console.log(`✅ Wrote ${jobs.length} jobs to ${filePath}`);

  } catch (error) {
    // Clean up temp file if write failed
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
    throw error;
  }
}

/**
 * Write metadata file
 * @param {Object} metadata - Metadata object
 * @param {string} filePath - Output file path
 * @returns {Promise<void>}
 */
async function writeMetadata(metadata, filePath) {
  const dir = path.dirname(filePath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${filePath}.tmp`;

  try {
    // Write to temp file
    fs.writeFileSync(tempPath, JSON.stringify(metadata, null, 2), 'utf8');

    // Atomic rename
    fs.renameSync(tempPath, filePath);

    console.log(`✅ Wrote metadata to ${filePath}`);

  } catch (error) {
    // Clean up temp file
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (cleanupError) {
        // Ignore
      }
    }
    throw error;
  }
}

/**
 * Read jobs from JSONL file
 * @param {string} filePath - File path to read
 * @returns {Array} - Array of job objects
 */
function readJobsJSONL(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(line => line);

    return lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (error) {
        console.warn(`⚠️ Failed to parse line: ${line.substring(0, 50)}...`);
        return null;
      }
    }).filter(job => job !== null);

  } catch (error) {
    console.error(`❌ Error reading ${filePath}:`, error.message);
    return [];
  }
}

/**
 * Read metadata file
 * @param {string} filePath - File path to read
 * @returns {Object} - Metadata object
 */
function readMetadata(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`❌ Error reading ${filePath}:`, error.message);
    return null;
  }
}

module.exports = {
  writeJobsJSONL,
  writeMetadata,
  readJobsJSONL,
  readMetadata
};
