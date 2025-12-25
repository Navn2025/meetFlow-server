// ═══════════════════════════════════════════════════════════════════════════════
// mediasoup/router.manager.js
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: This file manages mediasoup "Routers"
//
// WHAT IS A ROUTER?
// - A Router is like a "virtual room" where media flows
// - Think of it like a WiFi router - devices connect to it, and it routes data
// - Each video call room gets ONE Router
// - The Router knows what audio/video formats (codecs) it can handle
// - Producers send media TO the router, Consumers receive media FROM the router
//
// RELATIONSHIP:
// Worker (CPU core) → Router (Room) → Transports → Producers/Consumers
//
// ANALOGY:
// - Router = Post Office
// - Producers = People sending letters (your camera/mic)
// - Consumers = People receiving letters (watching others' video)
// - The Router routes letters from senders to receivers
//
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────────────────────────────────────

import {getWorker, updateWorkerLoad} from "./worker.manager.js";
// getWorker: Gets the least busy worker to create a router on
// updateWorkerLoad: Updates worker statistics when routers are created/closed

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL DATA STORAGE
// ─────────────────────────────────────────────────────────────────────────────

const rooms=new Map();
// WHAT: A Map to store all active rooms
// STRUCTURE: roomId (string) → RoomData (object containing router + metadata)
//
// EXAMPLE:
// rooms = {
//   "room-abc123": RoomData { router, workerPid, peers, producers, ... },
//   "room-xyz789": RoomData { router, workerPid, peers, producers, ... },
// }
//
// WHY Map? 
// - Fast lookup by roomId: O(1)
// - Easy to check if room exists: rooms.has(roomId)
// - Easy to delete: rooms.delete(roomId)

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA CODECS CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
// 
// WHAT ARE CODECS?
// - Codecs are algorithms to compress/decompress audio and video
// - "Codec" = "Coder-Decoder"
// - Different browsers support different codecs
// - We list all codecs we want to support, so more browsers can work
//
// WHY THESE SPECIFIC CODECS?
// - Opus: Best audio codec (small size, high quality, universal support)
// - VP8: Safe video codec (works everywhere, royalty-free)
// - VP9: Better compression than VP8 (same quality, smaller files)
// - H264: Hardware accelerated on most devices (fast, but patent issues)
//
// ─────────────────────────────────────────────────────────────────────────────

const mediaCodecs=[
    // ═══════════════════════════════════════════════════════════════════════
    // AUDIO CODEC: OPUS
    // ═══════════════════════════════════════════════════════════════════════
    {
        kind: "audio",
        // WHAT: Type of media this codec handles
        // VALUES: "audio" or "video"

        mimeType: "audio/opus",
        // WHAT: MIME type - standard way to identify codec
        // "audio/opus" = Opus audio codec
        // Opus is THE best audio codec for real-time communication

        clockRate: 48000,
        // WHAT: Sample rate in Hz (samples per second)
        // 48000 = 48 kHz = CD quality audio
        // Higher = better quality but more bandwidth

        channels: 2,
        // WHAT: Number of audio channels
        // 1 = Mono (single channel)
        // 2 = Stereo (left + right channels)

        parameters: {
            minptime: 10,
            // WHAT: Minimum packet time in milliseconds
            // Lower = less latency, more packets
            // 10ms is good for real-time communication

            useinbandfec: 1,
            // WHAT: Use in-band Forward Error Correction
            // 1 = enabled, 0 = disabled
            // FEC helps recover lost packets (important for bad networks)
        },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // VIDEO CODEC: VP8
    // ═══════════════════════════════════════════════════════════════════════
    {
        kind: "video",
        mimeType: "video/VP8",
        // VP8: Open-source, royalty-free video codec
        // Works in all modern browsers
        // Developed by Google (part of WebM project)

        clockRate: 90000,
        // WHAT: Clock rate for video (always 90000 for video in RTP)
        // This is a standard, not related to frame rate

        parameters: {
            "x-google-start-bitrate": 1000,
            // WHAT: Recommended starting bitrate in kbps
            // 1000 kbps = 1 Mbps = good quality video
            // Browser will adjust based on network conditions
        },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // VIDEO CODEC: VP9
    // ═══════════════════════════════════════════════════════════════════════
    {
        kind: "video",
        mimeType: "video/VP9",
        // VP9: Successor to VP8
        // Better compression (same quality at lower bitrate)
        // Requires more CPU to encode/decode

        clockRate: 90000,

        parameters: {
            "profile-id": 2,
            // WHAT: VP9 profile (0, 1, 2, or 3)
            // Profile 2 = 10-bit color support
            // Higher profiles = better quality, more CPU

            "x-google-start-bitrate": 1000,
        },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // VIDEO CODEC: H264 (Baseline Profile)
    // ═══════════════════════════════════════════════════════════════════════
    {
        kind: "video",
        mimeType: "video/H264",
        // H264: Most widely supported video codec
        // Hardware accelerated on almost all devices
        // Used by YouTube, Netflix, etc.

        clockRate: 90000,

        parameters: {
            "packetization-mode": 1,
            // WHAT: How to split video into RTP packets
            // 0 = Single NAL unit mode (simple)
            // 1 = Non-interleaved mode (recommended for WebRTC)

            "profile-level-id": "42e01f",
            // WHAT: H264 profile and level encoded as hex
            // "42e01f" = Constrained Baseline Profile, Level 3.1
            // Breakdown: 42 = profile, e0 = constraints, 1f = level
            // Baseline = works on more devices, less features

            "level-asymmetry-allowed": 1,
            // WHAT: Allow different encode/decode levels
            // 1 = allowed (more flexible)

            "x-google-start-bitrate": 1000,
        },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // VIDEO CODEC: H264 (High Profile)
    // ═══════════════════════════════════════════════════════════════════════
    {
        kind: "video",
        mimeType: "video/H264",

        clockRate: 90000,

        parameters: {
            "packetization-mode": 1,

            "profile-level-id": "4d0032",
            // "4d0032" = Main Profile, Level 5.0
            // Main Profile = better compression than Baseline
            // Level 5.0 = supports higher resolutions (up to 4K)

            "level-asymmetry-allowed": 1,
            "x-google-start-bitrate": 1000,
        },
    },
];

// ═══════════════════════════════════════════════════════════════════════════════
// CLASS: RoomData
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Store all data related to a single room
//
// CONTAINS:
// - router: The mediasoup Router object for this room
// - workerPid: Which worker this router runs on
// - peers: All connected users in this room
// - producers: All active media streams in this room
// - createdAt: When the room was created
// - maxPeers: Maximum allowed users
//
// ═══════════════════════════════════════════════════════════════════════════════

class RoomData
{
    constructor(router, workerPid)
    {
        // Called when creating a new room

        this.router=router;
        // WHAT: The mediasoup Router object
        // This is the core object that handles media routing

        this.workerPid=workerPid;
        // WHAT: Process ID of the worker this router runs on
        // Used for load tracking and debugging

        this.peers=new Map();
        // WHAT: Map of all peers (users) in this room
        // STRUCTURE: peerId → PeerData
        // Used to track who's in the room

        this.producers=new Map();
        // WHAT: Map of all producers (media streams) in this room
        // STRUCTURE: producerId → { peerId, kind, userName }
        // Used to tell new joiners what streams exist

        this.createdAt=Date.now();
        // WHAT: Timestamp when room was created
        // Date.now() returns milliseconds since Jan 1, 1970 (Unix epoch)
        // Used to calculate room uptime

        this.maxPeers=150;
        // WHAT: Maximum number of peers allowed in this room
        // Can be overridden when checking capacity
    }

    // ─────────────────────────────────────────────────────────────────────
    // METHOD: addPeer
    // PURPOSE: Add a new user to this room's tracking
    // ─────────────────────────────────────────────────────────────────────
    addPeer(peerId, peerData)
    {
        this.peers.set(peerId, peerData);
        // Add peer to our Map
    }

    // ─────────────────────────────────────────────────────────────────────
    // METHOD: removePeer
    // PURPOSE: Remove a user from this room's tracking
    // ─────────────────────────────────────────────────────────────────────
    removePeer(peerId)
    {
        this.peers.delete(peerId);
        // Remove peer from our Map
    }

    // ─────────────────────────────────────────────────────────────────────
    // METHOD: getPeerCount
    // PURPOSE: Get how many users are in this room
    // ─────────────────────────────────────────────────────────────────────
    getPeerCount()
    {
        return this.peers.size;
        // .size gives us the number of entries in a Map
    }

    // ─────────────────────────────────────────────────────────────────────
    // METHOD: getAllProducers
    // PURPOSE: Get a list of all producers in this room
    // ─────────────────────────────────────────────────────────────────────
    getAllProducers()
    {
        return Array.from(this.producers.entries());
        // Convert Map to array of [key, value] pairs
        // Returns: [[producerId1, data1], [producerId2, data2], ...]
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: getOrCreateRouter
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Get an existing router for a room, or create a new one
//
// WHEN CALLED: When a user joins a room
//
// PARAMETERS:
// - roomId: The unique ID of the room
//
// RETURNS: The mediasoup Router object for this room
//
// FLOW:
// 1. Check if router already exists for this room
// 2. If yes, return existing router
// 3. If no, get a worker, create router, set up monitoring, return router
//
// ═══════════════════════════════════════════════════════════════════════════════

export const getOrCreateRouter=async (roomId) =>
{

    // ─── Check if router already exists ───
    if (rooms.has(roomId))
    {
        // rooms.has() returns true if roomId exists in our Map
        return rooms.get(roomId).router;
        // Return the existing router (don't create a new one)
    }

    // ─── Get a worker to create the router on ───
    const worker=getWorker();
    // getWorker() returns the least loaded worker (load balancing)

    console.log(`Creating router for room ${roomId} on worker PID ${worker.pid}`);
    // 🟡 Yellow = work in progress

    // ─── Create the router on the worker ───
    const router=await worker.createRouter({mediaCodecs});
    // worker.createRouter() creates a new Router object
    // We pass our codec configuration so the router knows what formats to accept
    // "await" because this is an async operation

    // ─── Update worker load tracking ───
    updateWorkerLoad(worker.pid, "routers", 1);
    // Tell the worker manager that this worker now has +1 router

    // ─── Create room data and store it ───
    const roomData=new RoomData(router, worker.pid);
    // Create a new RoomData object to store router + metadata

    rooms.set(roomId, roomData);
    // Store in our global rooms Map
    // Now rooms.get(roomId) will return this roomData

    // ─── Monitor router close event ───
    router.observer.on("close", () =>
    {
        // This fires when the router is closed

        console.log(`Router closed for room ${roomId}`);
        // 🔴 Red = something stopped

        updateWorkerLoad(worker.pid, "routers", -1);
        // Tell worker manager this worker now has -1 router
    });

    // ─── Monitor new transports created on this router ───
    router.observer.on("newtransport", (transport) =>
    {
        // This fires every time a transport is created on this router

        updateWorkerLoad(worker.pid, "transports", 1);
        // +1 transport on this worker

        transport.observer.on("close", () =>
        {
            // When the transport closes
            updateWorkerLoad(worker.pid, "transports", -1);
            // -1 transport on this worker
        });
    });

    console.log(` Router created for room ${roomId} (codecs: ${mediaCodecs.length})`);
    // 🟢 Green = success
    // Log how many codecs this router supports

    return router;
    // Return the newly created router
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: getRouter
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Get an existing router for a room (doesn't create new one)
//
// WHEN CALLED: When we need the router but don't want to create one if missing
//
// PARAMETERS:
// - roomId: The unique ID of the room
//
// RETURNS: Router object if exists, undefined if not
//
// ═══════════════════════════════════════════════════════════════════════════════

export const getRouter=(roomId) =>
{
    const room=rooms.get(roomId);
    // Try to get the room from our Map
    // Returns undefined if roomId doesn't exist

    return room?.router;
    // Optional chaining (?.) - if room is undefined, return undefined
    // Otherwise return room.router
    // Same as: return room ? room.router : undefined;
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: getRoomData
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Get the full RoomData object (not just the router)
//
// WHEN CALLED: When you need access to peers, producers, etc.
//
// ═══════════════════════════════════════════════════════════════════════════════

export const getRoomData=(roomId) =>
{
    return rooms.get(roomId);
    // Return the entire RoomData object
    // Includes: router, workerPid, peers, producers, createdAt, maxPeers
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: registerProducer
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Track a new producer (media stream) in the room
//
// WHEN CALLED: When a user starts sharing their camera/mic
//
// WHY: So late joiners know what producers exist and can subscribe to them
//
// PARAMETERS:
// - roomId: Which room
// - producerId: Unique ID of the producer
// - peerId: Who created this producer (socket.id)
// - kind: "audio" or "video"
// - userName: Display name of the user
//
// ═══════════════════════════════════════════════════════════════════════════════

export const registerProducer=(roomId, producerId, peerId, kind, userName="Anonymous") =>
{
    const room=rooms.get(roomId);
    // Get the room

    if (room)
    {
        room.producers.set(producerId, {peerId, kind, userName});
        // Add to the room's producers Map
        // Structure: producerId → { peerId, kind, userName }
        //
        // EXAMPLE:
        // "producer-abc123" → { peerId: "socket-xyz", kind: "video", userName: "John" }
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: unregisterProducer
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Remove a producer from tracking when it closes
//
// WHEN CALLED: When a user stops sharing their camera/mic
//
// ═══════════════════════════════════════════════════════════════════════════════

export const unregisterProducer=(roomId, producerId) =>
{
    const room=rooms.get(roomId);

    if (room)
    {
        room.producers.delete(producerId);
        // Remove from the room's producers Map
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: getOtherProducers
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Get all producers in a room EXCEPT for one specific peer
//
// WHEN CALLED: When a new user joins and needs to know what to subscribe to
// They shouldn't subscribe to their own producers, so we exclude them
//
// PARAMETERS:
// - roomId: Which room
// - excludePeerId: Don't include producers from this peer
//
// RETURNS: Array of producer info objects
//
// EXAMPLE RETURN:
// [
//   { producerId: "prod-1", peerId: "socket-1", kind: "video", userName: "Alice" },
//   { producerId: "prod-2", peerId: "socket-1", kind: "audio", userName: "Alice" },
//   { producerId: "prod-3", peerId: "socket-2", kind: "video", userName: "Bob" },
// ]
//
// ═══════════════════════════════════════════════════════════════════════════════

export const getOtherProducers=(roomId, excludePeerId) =>
{
    const room=rooms.get(roomId);

    if (!room) return [];
    // If room doesn't exist, return empty array

    const producers=[];
    // Array to collect producer info

    // ─── Loop through all producers in the room ───
    for (const [producerId, data] of room.producers)
    {
        // Destructure: producerId = key, data = { peerId, kind, userName }

        if (data.peerId!==excludePeerId)
        {
            // Only include if it's not from the excluded peer

            producers.push({
                producerId,            // The producer's unique ID
                peerId: data.peerId,   // Who owns this producer
                kind: data.kind,       // "audio" or "video"
                userName: data.userName, // Display name
            });
        }
    }

    return producers;
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: getRoomStats
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Get statistics about a room (for monitoring/admin)
//
// RETURNS: Object with room stats, or null if room doesn't exist
//
// ═══════════════════════════════════════════════════════════════════════════════

export const getRoomStats=(roomId) =>
{
    const room=rooms.get(roomId);

    if (!room) return null;
    // Room doesn't exist

    return {
        peerCount: room.peers.size,
        // How many users are in the room

        producerCount: room.producers.size,
        // How many active media streams

        createdAt: room.createdAt,
        // When the room was created (timestamp)

        uptime: Date.now()-room.createdAt,
        // How long the room has been active (milliseconds)
        // e.g., 300000 = 5 minutes
    };
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: cleanupRoom
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Close and clean up a room when it's no longer needed
//
// WHEN CALLED: When the last user leaves a room
//
// WHAT IT DOES:
// 1. Clears all producers
// 2. Closes the router (releases resources)
// 3. Removes room from tracking
//
// ═══════════════════════════════════════════════════════════════════════════════

export const cleanupRoom=(roomId) =>
{
    const room=rooms.get(roomId);

    if (room&&room.router)
    {
        // Room exists and has a router

        try
        {
            room.producers.clear();
            // Clear all producers from tracking
            // The actual producer objects are closed elsewhere

            room.router.close();
            // Close the router
            // This releases all resources (transports, producers, consumers)

            console.log(` Router closed for room ${roomId}`);

        } catch (err)
        {
            console.error(`Error closing router for room ${roomId}:`, err.message);
            // Log error but continue cleanup
        }

        rooms.delete(roomId);
        // Remove room from our global Map
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: getActiveRooms
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Get a list of all active rooms (for admin/monitoring)
//
// RETURNS: Array of room info objects
//
// ═══════════════════════════════════════════════════════════════════════════════

export const getActiveRooms=() =>
{
    const activeRooms=[];

    // ─── Loop through all rooms ───
    for (const [roomId, room] of rooms)
    {
        // Destructure: roomId = key, room = RoomData object

        activeRooms.push({
            roomId,                              // Room ID
            peerCount: room.peers.size,          // Number of users
            producerCount: room.producers.size,  // Number of streams
            uptime: Date.now()-room.createdAt, // How long active
        });
    }

    return activeRooms;
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: isRoomFull
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Check if a room has reached its capacity
//
// WHEN CALLED: Before allowing a new user to join
//
// PARAMETERS:
// - roomId: Which room to check
// - maxPeers: Maximum allowed (default 100)
//
// RETURNS: true if full, false if has space
//
// ═══════════════════════════════════════════════════════════════════════════════

export const isRoomFull=(roomId, maxPeers=150) =>
{
    const room=rooms.get(roomId);

    if (!room) return false;
    // Room doesn't exist, so it's definitely not full!
    // (A new room will be created when user joins)

    return room.peers.size>=maxPeers;
    // Compare current peer count to maximum
    // Returns true if at or over capacity
};

// ═══════════════════════════════════════════════════════════════════════════════
// END OF FILE SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════
//
// EXPORTS:
// 1. getOrCreateRouter(roomId)  - Get/create router for a room
// 2. getRouter(roomId)          - Get existing router only
// 3. getRoomData(roomId)        - Get full room data object
// 4. registerProducer(...)      - Track new producer
// 5. unregisterProducer(...)    - Remove producer tracking
// 6. getOtherProducers(...)     - Get producers for subscription
// 7. getRoomStats(roomId)       - Get room statistics
// 8. cleanupRoom(roomId)        - Close room and free resources
// 9. getActiveRooms()           - List all active rooms
// 10. isRoomFull(roomId, max)   - Check room capacity
//
// TYPICAL FLOW:
// 1. User joins → getOrCreateRouter()
// 2. User shares camera → registerProducer()
// 3. Late joiner → getOtherProducers() to know what to subscribe to
// 4. User stops sharing → unregisterProducer()
// 5. Last user leaves → cleanupRoom()
//
// ═══════════════════════════════════════════════════════════════════════════════


