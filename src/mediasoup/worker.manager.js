// ═══════════════════════════════════════════════════════════════════════════════
// mediasoup/worker.manager.js
// ═══════════════════════════════════════════════════════════════════════════════
// 
// PURPOSE: This file manages mediasoup "Workers"
// 
// WHAT IS A WORKER?
// - A Worker is like a separate "engine" that runs mediasoup's C++ code
// - Think of it like a factory worker - each one can handle multiple tasks
// - Each Worker runs on a separate CPU core (for parallel processing)
// - Workers manage "Routers" which handle video rooms
//
// WHY MULTIPLE WORKERS?
// - Your computer has multiple CPU cores (like 4, 8, or 16 cores)
// - Using one worker = only 1 core is used = slow
// - Using multiple workers = all cores are used = fast & handles more users
//
// ANALOGY:
// - Imagine a restaurant kitchen
// - Worker = Chef
// - Router = Station (grill station, salad station, etc.)
// - More chefs = more orders can be handled simultaneously
//
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS - Bringing in external tools/libraries we need
// ─────────────────────────────────────────────────────────────────────────────

import { cpus } from "os";
// WHAT: "os" is Node.js's built-in module for Operating System information
// WHY: We use cpus() to find out how many CPU cores the computer has
// EXAMPLE: A computer with 8 cores will return an array of 8 items
// This helps us create the right number of workers (1 worker per core)

import { createWorker } from "mediasoup";
// WHAT: This is the function from mediasoup library to create a new Worker
// WHY: We need this to actually create the worker processes
// Each worker is a separate process that handles WebRTC media

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL VARIABLES - Data stored for the entire application
// ─────────────────────────────────────────────────────────────────────────────

const workers = [];
// WHAT: An empty array to store all our worker objects
// WHY: We need to keep track of all workers so we can:
//      1. Assign new rooms to them
//      2. Balance load between them
//      3. Handle if one dies/crashes
// EXAMPLE: After creating 4 workers, this array will have 4 worker objects

const workerLoads = new Map();
// WHAT: A Map (like a dictionary) to track how busy each worker is
// WHY: To do "load balancing" - give work to the least busy worker
// STRUCTURE: workerPid (process ID) -> { routers: 2, transports: 10, ... }
// 
// EXAMPLE:
// workerLoads = {
//   12345: { routers: 2, transports: 10, consumers: 5, producers: 5 },
//   12346: { routers: 1, transports: 5, consumers: 2, producers: 2 },
// }
// Worker 12346 has less load, so new rooms should go to it

let nextWorkerIndex = 0;
// WHAT: A counter for "round-robin" worker selection
// WHY: Simple backup method - if load balancing fails, just go in order
// HOW IT WORKS:
//   - Start at 0, pick worker[0]
//   - Next time, pick worker[1]
//   - After last worker, go back to worker[0]
// EXAMPLE: With 4 workers: 0 -> 1 -> 2 -> 3 -> 0 -> 1 -> 2 -> 3 -> ...

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION - Settings for how workers should behave
// ─────────────────────────────────────────────────────────────────────────────

const config = {

    portRangePerWorker: 1000,
    // WHAT: Each worker gets 1000 UDP ports to use
    // WHY: WebRTC needs UDP ports for sending/receiving video/audio data
    // EXAMPLE:
    //   Worker 0: ports 20000-20999 (1000 ports)
    //   Worker 1: ports 21000-21999 (1000 ports)
    //   Worker 2: ports 22000-22999 (1000 ports)
    // This prevents port conflicts between workers

    baseRtcPort: 20000,
    // WHAT: The starting port number for RTC (Real-Time Communication)
    // WHY: Ports below 20000 are often used by other services
    // NOTE: Make sure your firewall allows UDP on these ports!
    // Port range will be: 20000 to 20000 + (workers * 1000)

    workerSettings: {
        // Settings passed to each worker when created

        logLevel: "warn",
        // WHAT: How much logging/debugging info to show
        // OPTIONS: "debug" (most), "warn" (medium), "error" (least)
        // WHY: "warn" shows important issues without flooding the console
        // TIP: Use "debug" when troubleshooting problems

        logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
        // WHAT: Which specific things to log
        // MEANING:
        //   "info"  - General information
        //   "ice"   - ICE connection info (finding network path)
        //   "dtls"  - DTLS encryption handshake
        //   "rtp"   - RTP packets (actual media data)
        //   "srtp"  - Secure RTP (encrypted media)
        //   "rtcp"  - RTCP packets (quality feedback)

        rtcMinPort: 20000,//UDP port range start
        // WHAT: Minimum UDP port number (start of range)
        // Used as fallback if individual ranges fail

        rtcMaxPort: 59999,// UDP port range end
        // WHAT: Maximum UDP port number (end of range)
        // This gives us 40,000 ports total across all workers
    },

    maxTransportsPerWorker: 500,
    // WHAT: Maximum number of transports one worker should handle
    // WHY: Too many transports = worker becomes slow
    // TRANSPORT = A connection between server and client
    // 500 transports ≈ 250 users (each user has 2 transports: send + receive)

    maxRoutersPerWorker: 50,
    // WHAT: Maximum number of routers (rooms) one worker should handle
    // WHY: Each router uses memory and CPU
    // 50 routers = 50 different video call rooms on one worker
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: createWorkers()
// ═══════════════════════════════════════════════════════════════════════════════
// PURPOSE: Create all the mediasoup workers when server starts
// WHEN CALLED: Once, at server startup
// RETURNS: Nothing (but fills the 'workers' array)
//
// FLOW:
// 1. Count CPU cores
// 2. Create one worker per core
// 3. Set up each worker with port range
// 4. Set up crash handling for each worker
// 5. Store worker in array
// ═══════════════════════════════════════════════════════════════════════════════

export const createWorkers = async () => {
    // "async" because creating workers takes time (returns Promise)

    const cpuCount = cpus().length;
    // WHAT: Get the number of CPU cores on this computer
    // EXAMPLE: 8-core CPU returns 8
    // WHY: We create one worker per core for maximum performance
    // 
    // HOW cpus() WORKS:
    // Returns an array like: [{model: "Intel...", speed: 2400}, {...}, {...}]
    // .length gives us the count

    const workerCount = Math.max(2, cpuCount);
    // WHAT: Number of workers to create
    // Math.max(2, cpuCount) means: "Use cpuCount, but at least 2"
    // WHY: Even on a single-core machine, having 2 workers helps
    // EXAMPLE:
    //   cpuCount = 1 → workerCount = 2 (minimum)
    //   cpuCount = 4 → workerCount = 4
    //   cpuCount = 16 → workerCount = 16

    // ─────────────────────────────────────────────────────────────────────
    // LOOP: Create each worker one by one
    // ─────────────────────────────────────────────────────────────────────
    for (let i = 0; i < workerCount; i++) {
        // "i" is the worker index: 0, 1, 2, 3, etc.

        const rtcMinPort = config.baseRtcPort + (i * config.portRangePerWorker);
        // WHAT: Calculate the starting port for this worker
        // FORMULA: basePort + (workerIndex × portsPerWorker)
        // 
        // EXAMPLE with basePort=20000, portsPerWorker=1000:
        //   Worker 0: 20000 + (0 × 1000) = 20000
        //   Worker 1: 20000 + (1 × 1000) = 21000
        //   Worker 2: 20000 + (2 × 1000) = 22000
        //   Worker 3: 20000 + (3 × 1000) = 23000

        const rtcMaxPort = rtcMinPort + config.portRangePerWorker - 1;
        // WHAT: Calculate the ending port for this worker
        // FORMULA: startPort + portsPerWorker - 1
        // 
        // EXAMPLE:
        //   Worker 0: 20000 + 1000 - 1 = 20999
        //   Worker 1: 21000 + 1000 - 1 = 21999
        //
        // WHY -1? Because range is inclusive:
        //   20000 to 20999 = exactly 1000 ports (20000 counts as first)

        const worker = await createWorker({
            // WHAT: Actually create the mediasoup worker process
            // "await" because this is async (takes time to spawn process)
            
            logLevel: config.workerSettings.logLevel,
            // Pass the log level setting (e.g., "warn")

            logTags: config.workerSettings.logTags,
            // Pass which things to log (e.g., ["ice", "dtls", ...])

            rtcMinPort,
            // The starting port for this worker (e.g., 20000)
            // Shorthand for rtcMinPort: rtcMinPort

            rtcMaxPort,
            // The ending port for this worker (e.g., 20999)
            // Shorthand for rtcMaxPort: rtcMaxPort
        });

        // ─────────────────────────────────────────────────────────────────
        // Track this worker's load (starts at 0 for everything)
        // ─────────────────────────────────────────────────────────────────
        workerLoads.set(worker.pid, {
            // worker.pid = Process ID (unique number for this worker process)
            // e.g., 12345

            routers: 0,
            // Number of routers (rooms) this worker is handling
            // Starts at 0, increases when rooms are created

            transports: 0,
            // Number of transports (connections) this worker is handling
            // Each user has 2 transports (send + receive)

            consumers: 0,
            // Number of consumers (incoming media streams)
            // When you watch someone's video, that's a consumer

            producers: 0,
            // Number of producers (outgoing media streams)
            // When you share your camera, that's a producer
        });

        // ─────────────────────────────────────────────────────────────────
        // Handle worker crash/death
        // ─────────────────────────────────────────────────────────────────
        worker.on("died", (error) => {
            // WHAT: Event listener for when worker crashes
            // WHEN: If the worker process crashes or is killed
            // WHY: We need to handle this gracefully, not crash the whole server

            console.error(`Worker ${worker.pid} died:`, error);
            // Log the error so we know what happened

            workerLoads.delete(worker.pid);
            // Remove this worker from our load tracking
            // (It's dead, so it has no load anymore)

            // ─── Remove dead worker from our workers array ───
            const index = workers.findIndex(w => w.pid === worker.pid);
            // Find the position of this worker in our array
            // findIndex returns -1 if not found, otherwise the index (0, 1, 2, etc.)

            if (index !== -1) {
                // If we found it (index is not -1)
                workers.splice(index, 1);
                // splice(index, 1) removes 1 item at that index
                // This removes the dead worker from our array
            }

            // ─── Try to restart the worker after 2 seconds ───
            setTimeout(async () => {
                // setTimeout waits 2000ms (2 seconds) before running the code
                // WHY wait? Give the system time to clean up the crashed process

                try {
                    await restartWorker(i, rtcMinPort, rtcMaxPort);
                    // Try to create a new worker with the same port range
                    // This keeps our worker count stable

                } catch (err) {
                    console.error("Failed to restart worker:", err);
                    // If restart fails, log the error

                    if (workers.length === 0) {
                        // If ALL workers are dead and restart failed
                        console.error("All workers dead, exiting...");
                        process.exit(1);
                        // Exit the application with error code 1
                        // This tells the system "something went wrong"
                        // A process manager (like PM2) can then restart the whole app
                    }
                }
            }, 2000);
            // 2000 milliseconds = 2 seconds delay
        });

        // ─────────────────────────────────────────────────────────────────
        // Monitor when new routers are created on this worker
        // ─────────────────────────────────────────────────────────────────
        worker.observer.on("newrouter", (router) => {
            // WHAT: Event that fires when a new router is created
            // worker.observer is a special event emitter for monitoring

            const load = workerLoads.get(worker.pid);
            // Get current load stats for this worker

            if (load) load.routers++;
            // If load exists, increment the router count
            // load.routers++ is shorthand for load.routers = load.routers + 1

            console.log(`Worker ${worker.pid}: +1 router (total: ${load?.routers})`);
            // Log the update
            // load?.routers uses optional chaining - if load is null, returns undefined
        });

        // ─────────────────────────────────────────────────────────────────
        // Add this worker to our global array
        // ─────────────────────────────────────────────────────────────────
        workers.push(worker);
        // Add the worker object to the end of our workers array
        // Now we can access it later for creating routers
    }
    // End of for loop - all workers have been created

};
// End of createWorkers function

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: restartWorker()
// ═══════════════════════════════════════════════════════════════════════════════
// PURPOSE: Restart a worker that died/crashed
// WHEN CALLED: After a worker dies (called from the "died" event handler)
// PARAMETERS:
//   - index: Which worker number it was (0, 1, 2, etc.)
//   - rtcMinPort: Starting port for this worker
//   - rtcMaxPort: Ending port for this worker
// RETURNS: The new worker object
// ═══════════════════════════════════════════════════════════════════════════════

const restartWorker = async (index, rtcMinPort, rtcMaxPort) => {
    // This function recreates a crashed worker

    const worker = await createWorker({
        // Create a new worker with same settings as before

        logLevel: config.workerSettings.logLevel,
        // Same log level as other workers

        logTags: config.workerSettings.logTags,
        // Same log tags as other workers

        rtcMinPort,
        // Use the same port range start that the dead worker had

        rtcMaxPort,
        // Use the same port range end that the dead worker had
    });

    // ─── Initialize load tracking for the new worker ───
    workerLoads.set(worker.pid, {
        routers: 0,      // Fresh start - no routers yet
        transports: 0,   // No transports
        consumers: 0,    // No consumers
        producers: 0,    // No producers
    });

    // ─── Add to our workers array ───
    workers.push(worker);
    // The new worker is now available for handling new rooms

    console.log(` Worker restarted (PID: ${worker.pid})`);
    // Log success with the new process ID
    // 🔄 emoji indicates restart/refresh

    return worker;
    // Return the new worker (in case caller needs it)
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: getWorker()
// ═══════════════════════════════════════════════════════════════════════════════
// PURPOSE: Get the least busy worker for a new task
// WHEN CALLED: When creating a new room/router
// RETURNS: The worker object with the lowest load
//
// HOW LOAD BALANCING WORKS:
// - Each worker has a "load score"
// - Lower score = less busy = better choice
// - Score formula: (routers × 10) + transports + (consumers × 0.5)
// - Routers are weighted more because they use more resources
//
// EXAMPLE:
//   Worker A: 2 routers, 10 transports, 5 consumers = 2×10 + 10 + 5×0.5 = 32.5
//   Worker B: 1 router, 5 transports, 2 consumers = 1×10 + 5 + 2×0.5 = 16
//   → Worker B is chosen (lower score = less busy)
// ═══════════════════════════════════════════════════════════════════════════════

export const getWorker = () => {
    // "export" makes this function available to other files

    if (workers.length === 0) {
        // Safety check: if no workers exist, we can't continue
        throw new Error("No workers available");
        // This stops execution and tells the caller there's a problem
    }

    // ─── Initialize with first worker as default ───
    let leastLoadedWorker = workers[0];
    // Start by assuming the first worker is the least loaded

    let leastLoad = Infinity;
    // Start with infinity so ANY real load will be smaller
    // Infinity is a special JavaScript number larger than any other number

    // ─── Loop through all workers to find the least busy one ───
    for (const worker of workers) {
        // "for...of" loops through each worker in the array

        const load = workerLoads.get(worker.pid);
        // Get this worker's load statistics from our Map

        if (load) {
            // If we have load data for this worker

            // ─── Calculate weighted load score ───
            const loadScore = load.routers * 10 + load.transports + load.consumers * 0.5;
            // 
            // BREAKDOWN:
            // - load.routers × 10  → Routers are heavy (×10 weight)
            // - load.transports    → Transports are medium (×1 weight)  
            // - load.consumers × 0.5 → Consumers are light (×0.5 weight)
            //
            // WHY THESE WEIGHTS?
            // - Routers: Use significant memory and manage all room traffic
            // - Transports: Each is a WebRTC connection (moderate resources)
            // - Consumers: Just receiving streams (lightest operation)

            if (loadScore < leastLoad) {
                // If this worker has a lower score than current best

                leastLoad = loadScore;
                // Update our record of the lowest load

                leastLoadedWorker = worker;
                // This worker is now our best choice
            }
        }
    }

    return leastLoadedWorker;
    // Return the worker with the lowest load score
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: getWorkerRoundRobin()
// ═══════════════════════════════════════════════════════════════════════════════
// PURPOSE: Simple worker selection - just go in order (0, 1, 2, 3, 0, 1, ...)
// WHEN USED: As a simple fallback if load balancing isn't needed
// RETURNS: The next worker in the rotation
//
// ROUND-ROBIN EXPLAINED:
// - Like dealing cards: give one to each person, then start over
// - Worker 0, Worker 1, Worker 2, Worker 3, Worker 0, Worker 1, ...
// - Fair distribution, but doesn't consider actual worker load
// ═══════════════════════════════════════════════════════════════════════════════

export const getWorkerRoundRobin = () => {

    if (workers.length === 0) {
        // Safety check: no workers available
        throw new Error("No workers available");
    }

    const worker = workers[nextWorkerIndex];
    // Get the worker at the current index position
    // First call: nextWorkerIndex=0, so workers[0]
    // Second call: nextWorkerIndex=1, so workers[1]

    nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
    // Move to next index, wrap around if needed
    //
    // HOW % (MODULO) WORKS:
    // % gives the remainder after division
    // 
    // EXAMPLE with 4 workers (workers.length = 4):
    //   (0 + 1) % 4 = 1 % 4 = 1  → next is index 1
    //   (1 + 1) % 4 = 2 % 4 = 2  → next is index 2
    //   (2 + 1) % 4 = 3 % 4 = 3  → next is index 3
    //   (3 + 1) % 4 = 4 % 4 = 0  → WRAPS to index 0!
    //   (0 + 1) % 4 = 1 % 4 = 1  → cycle continues...

    return worker;
    // Return the selected worker
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: updateWorkerLoad()
// ═══════════════════════════════════════════════════════════════════════════════
// PURPOSE: Update the load statistics for a worker
// WHEN CALLED: When transports, consumers, or producers are added/removed
// PARAMETERS:
//   - workerPid: The process ID of the worker to update
//   - type: What to update ("routers", "transports", "consumers", "producers")
//   - delta: How much to change (+1 for add, -1 for remove)
//
// EXAMPLE USAGE:
//   updateWorkerLoad(12345, "transports", 1);   // Add 1 transport
//   updateWorkerLoad(12345, "transports", -1);  // Remove 1 transport
// ═══════════════════════════════════════════════════════════════════════════════

export const updateWorkerLoad = (workerPid, type, delta) => {

    const load = workerLoads.get(workerPid);
    // Get the current load object for this worker
    // e.g., { routers: 2, transports: 10, consumers: 5, producers: 5 }

    if (load && load[type] !== undefined) {
        // Check that:
        // 1. load exists (worker is being tracked)
        // 2. load[type] exists (valid property name)
        //
        // load[type] is "bracket notation" - same as:
        //   if type = "transports", then load[type] = load.transports

        load[type] += delta;
        // Add delta to the current value
        //
        // EXAMPLES:
        //   load.transports = 10, delta = 1  → load.transports = 11
        //   load.transports = 10, delta = -1 → load.transports = 9
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: getWorkerStats()
// ═══════════════════════════════════════════════════════════════════════════════
// PURPOSE: Get statistics about all workers (for monitoring/debugging)
// WHEN CALLED: When you want to see how busy each worker is
// RETURNS: Array of objects with each worker's PID and load stats
//
// EXAMPLE RETURN VALUE:
// [
//   { pid: 12345, routers: 2, transports: 10, consumers: 5, producers: 5 },
//   { pid: 12346, routers: 1, transports: 5, consumers: 2, producers: 2 },
// ]
// ═══════════════════════════════════════════════════════════════════════════════

export const getWorkerStats = () => {

    return workers.map(worker => ({
        // .map() transforms each worker into a new object

        pid: worker.pid,
        // Include the process ID

        ...workerLoads.get(worker.pid),
        // "..." is spread operator - copies all properties from the load object
        // Same as: routers: load.routers, transports: load.transports, etc.
    }));

    // BREAKDOWN OF WHAT .map() DOES:
    // workers = [worker1, worker2, worker3]
    //           ↓ map transforms each one ↓
    // result = [
    //   { pid: 12345, routers: 2, transports: 10, consumers: 5, producers: 5 },
    //   { pid: 12346, routers: 1, transports: 5, consumers: 2, producers: 2 },
    //   { pid: 12347, routers: 3, transports: 15, consumers: 8, producers: 8 },
    // ]
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: getWorkerCount()
// ═══════════════════════════════════════════════════════════════════════════════
// PURPOSE: Get the total number of active workers
// WHEN CALLED: For monitoring or logging
// RETURNS: A number (e.g., 4)
// ═══════════════════════════════════════════════════════════════════════════════

export const getWorkerCount = () => workers.length;
// Simply returns the length of the workers array
// workers.length gives us how many workers exist
// e.g., [w1, w2, w3, w4].length = 4

// ═══════════════════════════════════════════════════════════════════════════════
// END OF FILE SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════
//
// EXPORTS (functions other files can use):
// 1. createWorkers()      - Create all workers at startup
// 2. getWorker()          - Get least loaded worker (smart)
// 3. getWorkerRoundRobin() - Get next worker in rotation (simple)
// 4. updateWorkerLoad()   - Update worker statistics
// 5. getWorkerStats()     - Get all worker statistics
// 6. getWorkerCount()     - Get number of workers
//
// TYPICAL USAGE FLOW:
// 1. Server starts → call createWorkers()
// 2. User joins room → call getWorker() to pick best worker
// 3. Create router on that worker
// 4. As resources are created/destroyed → call updateWorkerLoad()
// 5. For monitoring → call getWorkerStats() or getWorkerCount()
//
// ═══════════════════════════════════════════════════════════════════════════════

