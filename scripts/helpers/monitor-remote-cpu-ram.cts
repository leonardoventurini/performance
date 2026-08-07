import type { IncomingMessage } from 'node:http';

const https = require('https');

interface GalaxyMetricResponse {
    readonly connections: readonly { readonly connections: number }[];
    readonly cpu: readonly { readonly percentage: number }[];
    readonly memory: readonly { readonly value: number }[];
}

interface GalaxyAverages {
    readonly averageConnections: number;
    readonly averageCpuPercentage: number;
    readonly averageMemoryUsage: number;
}

// Function to fetch data from the API
function fetchData(): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
        const requestBody = JSON.stringify({
            token: process.env.GALAXY_TOKEN,
            hostname: process.env.GALAXY_APP,
            region: "us-east-1",
            seriesName: "5s",
        });

        const options = {
            hostname: 'galaxy-beta.meteor.com',
            path: '/api/container-metrics',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
            },
        };

        const req = https.request(options, (res: IncomingMessage) => {
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

        // Write the request body
        req.write(requestBody);
        req.end();
    });
}

// Function to calculate averages
function isMetricResponse(value: unknown): value is GalaxyMetricResponse {
    if (typeof value !== 'object' || value === null) return false;
    return 'connections' in value && Array.isArray(value.connections)
        && value.connections.every((entry: unknown) => typeof entry === 'object' && entry !== null && 'connections' in entry && typeof entry.connections === 'number')
        && 'cpu' in value && Array.isArray(value.cpu)
        && value.cpu.every((entry: unknown) => typeof entry === 'object' && entry !== null && 'percentage' in entry && typeof entry.percentage === 'number')
        && 'memory' in value && Array.isArray(value.memory)
        && value.memory.every((entry: unknown) => typeof entry === 'object' && entry !== null && 'value' in entry && typeof entry.value === 'number');
}

function calculateAverages(data: unknown): GalaxyAverages {
    if (!Array.isArray(data) || !isMetricResponse(data[0])) {
        throw new TypeError('Galaxy metrics response has an invalid shape');
    }
    const connectionsData = data[0].connections;
    const cpuData = data[0].cpu;
    const memoryData = data[0].memory;

    // Calculate average connections
    const totalConnections = connectionsData.reduce((acc: number, connection) => acc + connection.connections, 0);
    const averageConnections = totalConnections / connectionsData.length;

    // Calculate average CPU percentage
    const totalCpuPercentage = cpuData.reduce((acc: number, cpu) => acc + cpu.percentage, 0);
    const averageCpuPercentage = totalCpuPercentage / cpuData.length;

    // Calculate average memory usage
    const totalMemoryUsage = memoryData.reduce((acc: number, memory) => acc + memory.value, 0);
    const averageMemoryUsage = totalMemoryUsage / memoryData.length;

    return {
        averageConnections,
        averageCpuPercentage,
        averageMemoryUsage,
    };
}

// Main function to execute the script
async function main(): Promise<void> {
    try {
        const data = await fetchData();
        const averages = calculateAverages(data);

        console.log('---- Galaxy Container metrics ----');
        console.log('Average CPU Percentage:', averages.averageCpuPercentage);
        console.log('Average Memory Usage:', averages.averageMemoryUsage);

    } catch (error) {
        console.error('Error fetching data:', error);
    }
}

main();
