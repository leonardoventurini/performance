interface BundleNode {
  readonly name: string;
  readonly type?: string;
  readonly size?: number;
  readonly children?: readonly BundleNode[];
}

type PackageSize = readonly [packageName: string, size: number];
type SizeSummary = Record<string, Record<string, string>>;

function calculateSize(node: BundleNode): { totalSize: number; packageSizes: PackageSize[] } {
  let totalSize = 0;
  const packageSizes: PackageSize[] = [];

  // If the node is a package and hasn't been visited, calculate its size
  if (node.size) {
    totalSize += node.size;
  }

  // If the node has children, process each child
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      const { totalSize: childSize, packageSizes: childPackageSizes } = calculateSize(child);

      // Add the child's size to the total size
      totalSize += childSize;

      // Append the package sizes from this child
      packageSizes.push(...childPackageSizes);
    }
  }

  if (node.type === 'package') {
    packageSizes.push([node.name, totalSize]);
  }

  return { totalSize, packageSizes };
}

function processRoot(node: BundleNode): SizeSummary {
  const sizeSummary: SizeSummary = {};
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      if (child.type === 'bundle') {

        // Calculate the size of each "bundle" and print its total size
        const { totalSize: childSize, packageSizes } = calculateSize(child);

        sizeSummary['Total Size'] = {
          ...(sizeSummary['Total Size'] || {}),
          [child.name]: `${childSize} (${(childSize / 1000 / 1000).toFixed(2)} MB)`
        };

        // Print the breakdown of package sizes under this bundle
        packageSizes.forEach(([packageName, size]) => {
          sizeSummary[packageName] = {
            ...(sizeSummary[packageName] || {}),
            [child.name]: size != null ? `${size} (${(size / 1000).toFixed(2)} KB)` : '-',
          };
        });
      }
    }
  }

  return sizeSummary;
}

const https = require('https');
const http = require('http');

function fetchData(): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const url = process.env.MONITOR_SIZE_URL;
    if (url === undefined) {
      reject(new Error('MONITOR_SIZE_URL is required'));
      return;
    }
    const protocol = url.startsWith('https') ? https : http; // Check if URL starts with https

    const req = protocol.request(url, (res: IncomingMessage) => {
      let responseBody = '';

      // Collect response data
      res.on('data', (chunk: Buffer | string) => {
        responseBody += chunk;
      });

      // Handle the end of the response
      res.on('end', () => {
        try {
          const jsonResponse = JSON.parse(responseBody);
          resolve(jsonResponse);
        } catch (error) {
          reject(new Error('Error parsing JSON response: ' + error));
        }
      });
    });

    // Handle request errors
    req.on('error', (error: Error) => {
      reject(new Error('Request failed: ' + error));
    });

    req.end();
  });
}

function isBundleNode(value: unknown): value is BundleNode {
  if (typeof value !== 'object' || value === null || !('name' in value) || typeof value.name !== 'string') return false;
  if ('type' in value && value.type !== undefined && typeof value.type !== 'string') return false;
  if ('size' in value && value.size !== undefined && typeof value.size !== 'number') return false;
  return !('children' in value)
    || value.children === undefined
    || (Array.isArray(value.children) && value.children.every(isBundleNode));
}

async function main(): Promise<void> {
  try {
    const data = await fetchData();
    if (!isBundleNode(data)) throw new TypeError('Bundle visualizer response has an invalid shape');
    const sizeSummary = processRoot(data);
    console.table(sizeSummary);
  } catch (error) {
    console.error('Error fetching data:', error);
  }
}

main();
import type { IncomingMessage } from 'node:http';
