// ═══════════════════════════════════════════════════════════════════════════════
// mediasoup/transport.manager.js
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: This file manages mediasoup "Transports"
//
// WHAT IS A TRANSPORT?
// - A Transport is a connection between the client (browser) and server
// - Think of it like a "tunnel" or "pipe" for sending data
// - Each user needs TWO transports:
//   1. Send Transport: For sending their camera/mic to the server
//   2. Receive Transport: For receiving other users' camera/mic from server
//
// RELATIONSHIP:
// Worker → Router → Transport → Producer/Consumer
//
// ANALOGY:
// - Transport = Highway between two cities
// - Producer = Trucks going FROM your city (sending video)
// - Consumer = Trucks coming TO your city (receiving video)
// - Each direction needs its own lane (send/recv transport)
//
// TYPES OF TRANSPORTS:
// 1. WebRtcTransport - For browser clients (most common)
// 2. PlainRtpTransport - For recording or external streaming
// 3. PipeTransport - For connecting routers across workers
//
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────────────────────────────────────

import {getRouter} from "./router.manager.js";
// getRouter: Gets the router for a room (we create transports ON the router)

// ─────────────────────────────────────────────────────────────────────────────
// TRANSPORT CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
//
// These settings control how transports behave
// They affect connection reliability, bandwidth, and performance
//
// ─────────────────────────────────────────────────────────────────────────────

// Helper: Get announced IP and warn if not set
const getAnnouncedIp=() =>
{
    if (!process.env.ANNOUNCED_IP||process.env.ANNOUNCED_IP==="")
    {
        console.warn("[mediasoup] ANNOUNCED_IP environment variable is not set. If running on a public server, set ANNOUNCED_IP to your public IP address. Defaulting to null (local testing mode).");
        return null;
    }
    return process.env.ANNOUNCED_IP;
};

const transportConfig={
    // ═══════════════════════════════════════════════════════════════════════
    // LISTEN IPs - Where the server listens for connections
    // ═══════════════════════════════════════════════════════════════════════
    listenIps: [
        {
            ip: "0.0.0.0",
            announcedIp: getAnnouncedIp(),
        },
    ],

    // ═══════════════════════════════════════════════════════════════════════
    // BANDWIDTH SETTINGS
    // ═══════════════════════════════════════════════════════════════════════

    initialAvailableOutgoingBitrate: 1000000,
    // WHAT: Starting bitrate for outgoing media in bits per second
    // 1000000 = 1 Mbps = 1 megabit per second
    // This is a good starting point for video
    // The actual bitrate will adjust based on network conditions

    minimumAvailableOutgoingBitrate: 600000,
    // WHAT: Minimum bitrate the server will try to maintain
    // 600000 = 600 Kbps
    // Below this, video quality becomes very poor
    // mediasoup will try not to go below this

    maxSctpMessageSize: 262144,
    // WHAT: Maximum size of SCTP data messages in bytes
    // 262144 = 256 KB
    // SCTP is used for data channels (chat, file transfer, etc.)
    // Not used for audio/video (those use RTP)

    // ═══════════════════════════════════════════════════════════════════════
    // PROTOCOL SETTINGS
    // ═══════════════════════════════════════════════════════════════════════

    enableUdp: true,
    // WHAT: Allow UDP connections
    // UDP = User Datagram Protocol
    // WHY: UDP is faster but may lose packets
    // Best for real-time video (we prefer speed over reliability)

    enableTcp: true,
    // WHAT: Allow TCP connections as fallback
    // TCP = Transmission Control Protocol
    // WHY: Some networks block UDP (corporate firewalls)
    // TCP is slower but more reliable, works through more firewalls

    preferUdp: true,
    // WHAT: Prefer UDP over TCP when both are available
    // WHY: UDP is better for real-time communication (lower latency)
    // If UDP fails, will automatically fall back to TCP

    // ═══════════════════════════════════════════════════════════════════════
    // ICE SETTINGS
    // ═══════════════════════════════════════════════════════════════════════

    iceConsentTimeout: 20,
    // WHAT: Timeout for ICE consent in seconds
    // ICE = Interactive Connectivity Establishment
    // This is WebRTC's way of finding the best network path
    //
    // ICE Consent = Periodic check that connection is still alive
    // 20 seconds = If no response for 20s, consider connection dead
};

// ─────────────────────────────────────────────────────────────────────────────
// SEND TRANSPORT OPTIONS
// ─────────────────────────────────────────────────────────────────────────────
//
// Specific settings for transports that SEND media (producer side)
//
// ─────────────────────────────────────────────────────────────────────────────

const sendTransportOptions={
    ...transportConfig,
    // WHAT: Copy all settings from transportConfig
    // "..." is the spread operator - copies all properties

    enableSctp: false,
    // WHAT: Enable SCTP data channels
    // false = Don't enable (we only need audio/video, not data channels)
    // Set to true if you need file sharing or text chat over WebRTC

    numSctpStreams: {OS: 0, MIS: 0},
    // WHAT: Number of SCTP streams
    // OS = Outgoing Streams, MIS = Maximum Incoming Streams
    // 0 = No SCTP streams (we're not using data channels)
};

// ─────────────────────────────────────────────────────────────────────────────
// RECEIVE TRANSPORT OPTIONS
// ─────────────────────────────────────────────────────────────────────────────
//
// Specific settings for transports that RECEIVE media (consumer side)
//
// ─────────────────────────────────────────────────────────────────────────────

const recvTransportOptions={
    ...transportConfig,
    // Same base config as send transport

    enableSctp: false,
    numSctpStreams: {OS: 0, MIS: 0},
    // Same SCTP settings (disabled)
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: createWebRtcTransport
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Create a new WebRTC transport for a client
//
// WHEN CALLED: When a user joins a room and needs to send or receive media
//
// PARAMETERS:
// - roomId: Which room (to get the router)
// - type: "send" or "recv" (which kind of transport)
//
// RETURNS: Object containing:
// - transport: The transport object (kept on server)
// - params: Connection parameters (sent to client)
//
// FLOW:
// 1. Get the router for the room
// 2. Create transport on the router
// 3. Set bandwidth limits for receive transports
// 4. Return transport and connection parameters
//
// ═══════════════════════════════════════════════════════════════════════════════

export const createWebRtcTransport=async (roomId, type="send") =>
{
    // ─── Get the router for this room ───
    const router=getRouter(roomId);

    if (!router)
    {
        console.error(`[mediasoup] Router not found for roomId: ${roomId}`);
        throw new Error(`Router not found for roomId: ${roomId}`);
    }

    // ─── Choose options based on transport type ───
    const options=type==="send"? sendTransportOptions:recvTransportOptions;
    console.log(`[mediasoup] Creating WebRTC ${type} transport with options:`, JSON.stringify(options, null, 2));

    // ─── Create the transport on the router ───
    let transport;
    try
    {
        transport=await router.createWebRtcTransport(options);
    } catch (err)
    {
        console.error(`[mediasoup] Failed to create WebRTC ${type} transport:`, err);
        throw err;
    }

    // ─── Set bandwidth limit for receive transports ───
    if (type==="recv")
    {
        try
        {
            await transport.setMaxIncomingBitrate(1500000);
        } catch (err)
        {
            console.warn("Could not set max incoming bitrate:", err.message);
        }
    }

    // Log all transport parameters for debugging
    console.log(`[mediasoup] 🟢 WebRTC ${type} Transport created: ${transport.id}`);
    console.log(`[mediasoup] ICE Parameters:`, JSON.stringify(transport.iceParameters, null, 2));
    console.log(`[mediasoup] ICE Candidates:`, JSON.stringify(transport.iceCandidates, null, 2));
    console.log(`[mediasoup] DTLS Parameters:`, JSON.stringify(transport.dtlsParameters, null, 2));
    if (transport.sctpParameters)
    {
        console.log(`[mediasoup] SCTP Parameters:`, JSON.stringify(transport.sctpParameters, null, 2));
    }

    // ─── Return transport and connection parameters ───
    return {
        transport,
        params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            sctpParameters: transport.sctpParameters,
        },
    };
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: connectTransport
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Complete the transport connection (DTLS handshake)
//
// WHEN CALLED: After client receives transport parameters and is ready to connect
//
// WHAT IS DTLS HANDSHAKE?
// - DTLS = Datagram Transport Layer Security
// - It's encryption for WebRTC
// - Handshake = Client and server exchange keys to encrypt communication
// - After handshake, all media is encrypted
//
// PARAMETERS:
// - transportId: Which transport to connect
// - dtlsParameters: DTLS info from client (fingerprints, role)
// - roomId: Which room (for logging)
// - peer: The peer object (has transport maps)
//
// RETURNS: true on success
//
// ═══════════════════════════════════════════════════════════════════════════════

export const connectTransport=async (transportId, dtlsParameters, roomId, peer) =>
{
    // ─── Find the transport ───
    let transport=peer.sendTransports.get(transportId)||peer.recvTransports.get(transportId);
    if (!transport)
    {
        console.error(`[mediasoup] Transport not found: ${transportId} (roomId: ${roomId})`);
        throw new Error(`Transport not found: ${transportId}`);
    }

    try
    {
        console.log(`[mediasoup] Connecting transport ${transportId} (roomId: ${roomId}) with DTLS parameters:`, JSON.stringify(dtlsParameters, null, 2));
        await transport.connect({dtlsParameters});
        console.log(`🔗 Transport ${transportId} connected (DTLS OK)`);
        return true;
    } catch (err)
    {
        console.error(`[mediasoup] Transport connection failed for ${transportId} (roomId: ${roomId}):`, err.message, err);
        throw err;
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: createPlainRtpTransport
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Create a Plain RTP transport for external tools
//
// WHEN USED:
// - Recording: Send media to a recording server (like FFmpeg)
// - Streaming: Send to external streaming services
// - Telephony: Connect to SIP/VoIP systems
//
// WHY NOT WebRTC?
// - External tools often don't support WebRTC
// - Plain RTP is simpler (no ICE, no DTLS)
// - Works with standard media tools
//
// ═══════════════════════════════════════════════════════════════════════════════

export const createPlainRtpTransport=async (roomId) =>
{

    const router=getRouter(roomId);

    if (!router)
    {
        throw new Error(`Router not found for roomId: ${roomId}`);
    }

    // ─── Create Plain RTP transport ───
    const transport=await router.createPlainTransport({
        listenIp: {ip: "0.0.0.0", announcedIp: process.env.ANNOUNCED_IP||null},
        // Same IP config as WebRTC transport

        rtcpMux: true,
        // WHAT: Multiplex RTP and RTCP on same port
        // RTP = Media data, RTCP = Control/feedback data
        // true = Both on one port (simpler)
        // false = Separate ports for RTP and RTCP

        comedia: true,
        // WHAT: Enable COMEDIA mode
        // COMEDIA = "Connection-Oriented Media"
        // Instead of specifying remote IP/port, the transport
        // learns them from the first incoming packet
        // This is useful when the remote endpoint's address is unknown
    });

    return {
        transport,
        params: {
            id: transport.id,
            ip: transport.tuple.localIp,
            // WHAT: IP address to send RTP to
            // tuple = { localIp, localPort, protocol }

            port: transport.tuple.localPort,
            // WHAT: Port number to send RTP to

            rtcpPort: transport.rtcpTuple?.localPort,
            // WHAT: Separate RTCP port (if rtcpMux is false)
            // ?. = Optional chaining, returns undefined if rtcpTuple is null
        },
    };
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: createPipeTransport
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Create a pipe transport for connecting routers across workers
//
// WHEN USED:
// - Scaling beyond one CPU core
// - Connecting rooms on different workers
// - Advanced multi-server setups
//
// HOW IT WORKS:
// - PipeTransport connects two routers
// - Producers from one router can be "piped" to another
// - This allows rooms to span multiple workers
//
// EXAMPLE:
// Worker 1 has Router A (room-abc)
// Worker 2 has Router B (room-xyz)
// PipeTransport can connect them so a producer in A appears in B
//
// ═══════════════════════════════════════════════════════════════════════════════

export const createPipeTransport=async (roomId) =>
{

    const router=getRouter(roomId);

    if (!router)
    {
        throw new Error(`Router not found for roomId: ${roomId}`);
    }

    // ─── Create Pipe transport ───
    const transport=await router.createPipeTransport({
        listenIp: {ip: "127.0.0.1"},
        // WHAT: IP to listen on
        // "127.0.0.1" = localhost only
        // Pipe transports are typically used within the same server
        // For multi-server, use the actual server IP

        enableSctp: false,
        // No SCTP data channels needed for piping media

        enableRtx: false,
        // WHAT: Enable RTX (Retransmission)
        // RTX = Resend lost packets
        // false = Don't enable (pipe is local, no packet loss)

        enableSrtp: false,
        // WHAT: Enable SRTP encryption
        // false = No encryption (local pipe doesn't need it)
        // Set to true if piping between servers
    });

    return {
        transport,
        params: {
            id: transport.id,
            ip: transport.tuple.localIp,
            port: transport.tuple.localPort,
        },
    };
};

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: getTransportStats
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Get statistics about a transport (for monitoring/debugging)
//
// WHAT IT RETURNS:
// - Bytes sent/received
// - Packets sent/received
// - Bitrate
// - RTT (Round Trip Time)
// - And more...
//
// ═══════════════════════════════════════════════════════════════════════════════

export const getTransportStats=async (transport) =>
{
    try
    {
        const stats=await transport.getStats();
        // Returns an array of stats objects
        // Different stats for different transport types

        return stats;

    } catch (err)
    {
        console.error("Error getting transport stats:", err.message);
        return null;
        // Return null on error instead of throwing
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// END OF FILE SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════
//
// EXPORTS:
// 1. createWebRtcTransport(roomId, type) - Create browser transport
// 2. connectTransport(transportId, dtlsParams, roomId, peer) - Complete connection
// 3. createPlainRtpTransport(roomId) - Create for recording/streaming
// 4. createPipeTransport(roomId) - Create for multi-worker routing
// 5. getTransportStats(transport) - Get transport statistics
//
// TRANSPORT LIFECYCLE:
// 1. User joins room
// 2. Server creates SEND transport → sends params to client
// 3. Client creates local transport with params
// 4. Client calls connect → Server runs connectTransport (DTLS handshake)
// 5. Transport is now ready for producers/consumers
// 6. Repeat for RECV transport
// 7. When user leaves, close transports
//
// TYPICAL FLOW:
// Client: "I want to join room XYZ"
// Server: Creates send transport, returns {id, ice, dtls params}
// Client: Creates local transport, tries to connect
// Server: connectTransport() completes DTLS handshake
// Client: Now can send video through this transport!
//
// ═══════════════════════════════════════════════════════════════════════════════

