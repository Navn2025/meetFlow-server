// ═══════════════════════════════════════════════════════════════════════════════
// mediasoup/room.controller.js
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: This is the "brain" of the video conferencing system
// It handles ALL Socket.IO events for video calls
//
// WHAT DOES THIS FILE DO?
// 1. Handles users joining/leaving rooms
// 2. Creates transports (connections) for each user
// 3. Manages producers (sending video/audio)
// 4. Manages consumers (receiving video/audio)
// 5. Handles chat, hand raise, and other features
//
// FLOW OF A VIDEO CALL:
// 1. User connects via Socket.IO
// 2. User emits "joinRoom" → Server creates router, returns capabilities
// 3. User emits "createTransport" (send) → Server creates send transport
// 4. User emits "createTransport" (recv) → Server creates receive transport
// 5. User emits "produce" → Server creates producer (user's camera/mic)
// 6. Other users emit "consume" → Server creates consumers (view the producer)
// 7. User emits "leaveRoom" or disconnects → Server cleans up everything
//
// ANALOGY:
// Think of this as a receptionist at a conference center:
// - Greets people when they arrive (joinRoom)
// - Assigns them a microphone (producer)
// - Gives them headphones to hear others (consumer)
// - Announces when someone leaves (participantLeft)
// - Cleans up the room when everyone leaves (cleanupRoom)
//
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS - External functions and libraries we need
// ─────────────────────────────────────────────────────────────────────────────

import
{
    getOrCreateRouter,
    // WHAT: Gets existing router for a room, or creates one if it doesn't exist
    // WHEN: Called when first user joins a room

    getRouter,
    // WHAT: Gets the router for a room (must already exist)
    // WHEN: Called during consume to check codec compatibility

    cleanupRoom,
    // WHAT: Closes the router and frees resources for a room
    // WHEN: Called when last person leaves a room

    registerProducer,
    // WHAT: Registers a producer in the room's producer list
    // WHEN: Called when someone starts sharing their camera/mic

    unregisterProducer,
    // WHAT: Removes a producer from the room's list
    // WHEN: Called when someone stops sharing or disconnects

    getOtherProducers,
    // WHAT: Gets all producers in a room except the caller's
    // WHEN: Called when someone joins to see existing streams

    getRoomStats,
    // WHAT: Gets statistics about a room (peer count, etc.)
    // WHEN: Called for monitoring/debugging

    isRoomFull,
    // WHAT: Checks if room has reached maximum capacity
    // WHEN: Called before allowing someone to join
} from "./router.manager.js";

import {createWebRtcTransport, connectTransport} from "./transport.manager.js";
// createWebRtcTransport: Creates a new WebRTC transport (connection tunnel)
// connectTransport: Completes the DTLS handshake to secure the connection

import jwt from "jsonwebtoken";
// WHAT: Library for JSON Web Tokens
// WHY: We verify JWT tokens to authenticate users
// Users send their token when joining, we verify it's valid

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL DATA STRUCTURES - Store all active connections and rooms
// ─────────────────────────────────────────────────────────────────────────────

const peers=new Map();
// WHAT: Stores all connected users
// STRUCTURE: socketId (string) → PeerData (object)
//
// EXAMPLE:
// peers = {
//   "socket123": PeerData { socket, roomId, userId, producers, consumers, ... },
//   "socket456": PeerData { socket, roomId, userId, producers, consumers, ... },
// }
//
// WHY Map? Fast O(1) lookup by socket ID

const rooms=new Map();
// WHAT: Tracks which sockets are in which room
// STRUCTURE: roomId (string) → Set of socketIds
//
// EXAMPLE:
// rooms = {
//   "room-abc": Set { "socket123", "socket456", "socket789" },
//   "room-xyz": Set { "socket111", "socket222" },
// }
//
// WHY Set? Fast add/remove, no duplicates, easy iteration

const roomOwners=new Map();
// WHAT: Tracks who created/owns each room
// STRUCTURE: roomId (string) → socketId (string)
//
// EXAMPLE:
// roomOwners = {
//   "room-abc": "socket123",  // socket123 is the host
//   "room-xyz": "socket111",  // socket111 is the host
// }
//
// WHY: Only the owner can end the meeting for everyone

// ═══════════════════════════════════════════════════════════════════════════════
// CLASS: PeerData
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Store all information about a single connected user
//
// CONTAINS:
// - socket: The Socket.IO connection object
// - roomId: Which room they're in
// - userId: Their user ID from the database
// - userName: Their display name
// - sendTransports: Transports for sending media (Map)
// - recvTransports: Transports for receiving media (Map)
// - producers: Their active media streams they're sending (Map)
// - consumers: Media streams they're receiving from others (Map)
// - Various status flags (audio, video, hand raised, etc.)
//
// ANALOGY:
// Like a name badge at a conference that tracks:
// - Who you are (userId, userName)
// - What room you're in (roomId)
// - Your equipment (transports, producers, consumers)
// - Your current status (muted? camera on? hand raised?)
//
// ═══════════════════════════════════════════════════════════════════════════════

class PeerData
{
    constructor(socket, roomId, userId, userName, isOwner=false)
    {
        // Called when a new user joins a room

        this.socket=socket;
        // WHAT: The Socket.IO socket object for this user
        // WHY: We need this to send messages to this specific user
        // EXAMPLE: this.socket.emit("newProducer", {...})

        this.roomId=roomId;
        // WHAT: The ID of the room this user is in
        // WHY: To know which room to broadcast messages to
        // EXAMPLE: "room-abc123"

        this.userId=userId;
        // WHAT: The user's ID from the database (from JWT token)
        // WHY: To identify the user across reconnections
        // EXAMPLE: "user-xyz789"

        this.userName=userName||`User-${userId.slice(-4)}`;
        // WHAT: The user's display name
        // userName || `User-${...}` means:
        //   - Use userName if provided
        //   - Otherwise, use last 4 characters of userId as name
        // EXAMPLE: "John" or "User-z789"

        this.sendTransports=new Map();
        // WHAT: Map of transports for SENDING media (camera/mic → server)
        // STRUCTURE: transportId → Transport object
        // Usually just 1 send transport per user

        this.recvTransports=new Map();
        // WHAT: Map of transports for RECEIVING media (server → speakers/screen)
        // STRUCTURE: transportId → Transport object
        // Usually just 1 receive transport per user

        this.producers=new Map();
        // WHAT: Map of active producers (media streams this user is sending)
        // STRUCTURE: producerId → Producer object
        // EXAMPLE: One for audio, one for video, one for screen share

        this.consumers=new Map();
        // WHAT: Map of active consumers (media streams this user is receiving)
        // STRUCTURE: consumerId → Consumer object
        // EXAMPLE: If 5 people in room, you might have 10 consumers (audio+video each)

        this.joinedAt=Date.now();
        // WHAT: Timestamp when user joined (milliseconds since 1970)
        // WHY: For calculating how long they've been in the room
        // EXAMPLE: 1702468800000

        this.isAudioEnabled=false;
        // WHAT: Is the user's microphone on?
        // Starts false, becomes true when they produce audio

        this.isVideoEnabled=false;
        // WHAT: Is the user's camera on?
        // Starts false, becomes true when they produce video

        this.isScreenSharing=false;
        // WHAT: Is the user sharing their screen?
        // Separate from camera - you can have both on

        this.isHandRaised=false;
        // WHAT: Has the user raised their hand?
        // Feature for getting attention in a meeting

        this.isOwner=isOwner;
        // WHAT: Is this user the room owner/host?
        // First person to join becomes owner
        // Owner can end meeting for everyone
    }

    // ─────────────────────────────────────────────────────────────────────
    // METHOD: toPublicData()
    // ─────────────────────────────────────────────────────────────────────
    // PURPOSE: Convert peer data to a safe format for sending to clients
    // WHY: We can't send the socket object or internal data to clients
    // RETURNS: Object with only the information clients need
    // ─────────────────────────────────────────────────────────────────────

    toPublicData()
    {
        return {
            socketId: this.socket.id,
            // The socket ID (used as unique identifier)

            peerId: this.socket.id,
            // Same as socketId (some places use "peerId")

            userId: this.userId,
            // Database user ID

            userName: this.userName,
            // Display name

            isAudioEnabled: this.isAudioEnabled,
            // Is their mic on?

            isVideoEnabled: this.isVideoEnabled,
            // Is their camera on?

            isScreenSharing: this.isScreenSharing,
            // Are they screen sharing?

            isHandRaised: this.isHandRaised,
            // Is their hand raised?

            joinedAt: this.joinedAt,
            // When they joined

            isOwner: this.isOwner,
            // Are they the host?
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FUNCTION: roomController(io)
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Set up all Socket.IO event handlers for video conferencing
//
// PARAMETER:
// - io: The Socket.IO server instance
//
// WHAT IT DOES:
// 1. Listens for new socket connections
// 2. Sets up event handlers for each connected socket
// 3. Handles all the mediasoup signaling (join, transport, produce, consume, etc.)
//
// ═══════════════════════════════════════════════════════════════════════════════

export function roomController(io)
{
    // "export" makes this function available to other files
    // "io" is the Socket.IO server object

    // ─────────────────────────────────────────────────────────────────────
    // Listen for new connections
    // ─────────────────────────────────────────────────────────────────────
    io.on("connection", (socket) =>
    {
        // This runs every time a new client connects
        // "socket" is the individual connection to that client

        console.log("USER CONNECTED:", socket.id);
        // socket.id is a unique identifier for this connection
        // Example: "Xk2_jK3mN9pO1qR2"

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 1: JOIN ROOM
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: Client wants to join a video call room
        //
        // CLIENT SENDS:
        // - token: JWT token for authentication
        // - roomId: Which room to join
        // - userName: Display name (optional)
        //
        // SERVER RETURNS (via callback):
        // - routerRtpCapabilities: Codec info needed for WebRTC
        // - participants: List of people already in the room
        // - existingProducers: Video/audio streams already active
        // - peerId: The user's socket ID
        // - isOwner: Whether they're the room owner
        //
        // FLOW:
        // 1. Verify JWT token
        // 2. Check room capacity
        // 3. Create/get router for room
        // 4. Create peer data
        // 5. Notify others about new participant
        // 6. Return room info to client
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("joinRoom", async ({token, roomId, userName}, callback) =>
        {
            // "async" because we need to await router creation
            // Destructure the data: { token, roomId, userName }
            // "callback" is a function to send response back to client

            try
            {
                // ─── Step 1: Verify JWT token ───
                const decoded=jwt.verify(token, process.env.JWT_SECRET);
                // jwt.verify() decodes the token and checks if it's valid
                // If invalid, it throws an error (caught by catch block)
                // "decoded" contains the payload, like { id: "user123", email: "..." }

                const userId=decoded.id;
                // Extract the user ID from the decoded token

                if (!userId)
                {
                    // If no user ID in token, reject
                    return callback({error: "Unauthorized"});
                    // callback with error object - client will see this
                }

                // ─── Step 2: Check room capacity ───
                if (isRoomFull(roomId, 150))
                {
                    // isRoomFull(roomId, maxPeers) returns true if room is at capacity
                    // 150 = maximum allowed users per room
                    return callback({error: "Room is full"});
                }

                // ─── Step 3: Create or get router for room ───
                const router=await getOrCreateRouter(roomId);
                // If room exists, gets existing router
                // If room is new, creates a new router on least-loaded worker
                // "await" because router creation is async

                // ─── Step 4: Track room membership ───
                if (!rooms.has(roomId))
                {
                    // If this room doesn't exist in our tracking yet
                    rooms.set(roomId, new Set());
                    // Create a new Set to store socket IDs for this room
                }

                // ─── Step 5: Determine if this user is the owner ───
                const isOwner=!roomOwners.has(roomId);
                // If roomOwners doesn't have this room, no one has claimed it yet
                // So this user (first to join) becomes the owner

                if (isOwner)
                {
                    roomOwners.set(roomId, socket.id);
                    // Record this socket as the room owner
                }

                // ─── Step 6: Create peer data structure ───
                const peer=new PeerData(socket, roomId, userId, userName, isOwner);
                // Create a PeerData object with all the user's info
                peers.set(socket.id, peer);
                // Store in our peers Map for later lookup

                rooms.get(roomId).add(socket.id);
                // Add this socket to the room's Set of participants

                // ─── Step 7: Join Socket.IO room ───
                socket.join(roomId);
                // socket.join() is a Socket.IO feature
                // It adds this socket to a "room" for easy broadcasting
                // Now socket.to(roomId).emit() will reach everyone in the room

                const peerCount=rooms.get(roomId).size;
                // Get current number of people in room

                console.log(`User ${userId} joined room ${roomId} (${peerCount} peers)${isOwner? " [OWNER]":""}`);

                // ─── Step 8: Get existing participants for the new joiner ───
                const existingParticipants=getParticipantsInRoom(roomId, socket.id);
                // Get list of all participants except the new joiner
                // So new joiner knows who's already in the room

                // ─── Step 9: Notify others about new participant ───
                socket.to(roomId).emit("participantJoined", peer.toPublicData());
                // socket.to(roomId) = everyone in the room EXCEPT this socket
                // .emit("participantJoined", ...) = send event with peer's public data

                // ─── Step 10: Get existing producers (streams) ───
                const existingProducers=getOtherProducers(roomId, socket.id);
                // Get all active video/audio streams in the room
                // So new joiner can start consuming them

                // ─── Step 11: Send response to client ───
                callback({
                    routerRtpCapabilities: router.rtpCapabilities,
                    // RTP capabilities = what codecs the router supports
                    // Client needs this to set up mediasoup device

                    participants: existingParticipants,
                    // List of people already in room (for UI)

                    existingProducers: existingProducers,
                    // Active streams to consume

                    peerId: socket.id,
                    // This user's peer ID

                    isOwner: isOwner,
                    // Whether they're the room owner
                });

            } catch (err)
            {
                // Handle any errors (invalid token, router creation failed, etc.)
                console.log("joinRoom error =>", err.message);
                callback({error: "Join room failed: "+err.message});
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 2: CREATE TRANSPORT
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: Client needs a transport to send or receive media
        //
        // CLIENT SENDS:
        // - roomId: Which room
        // - type: "send" or "recv"
        //
        // SERVER RETURNS:
        // - Transport parameters (id, iceParameters, iceCandidates, dtlsParameters)
        //
        // WHAT IS A TRANSPORT?
        // - A WebRTC connection between client and server
        // - "send" transport: For sending your camera/mic to server
        // - "recv" transport: For receiving others' camera/mic from server
        // - Each user typically has 1 send + 1 recv transport
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("createTransport", async ({roomId, type}, callback) =>
        {
            try
            {
                // ─── Get peer data ───
                const peer=peers.get(socket.id);
                // Look up this user's peer data

                if (!peer) return callback({error: "Peer not found"});
                // If not found, user probably didn't join room first

                // ─── Create the transport ───
                const {transport, params}=await createWebRtcTransport(roomId, type);
                // createWebRtcTransport returns:
                // - transport: The actual transport object (kept on server)
                // - params: Connection info (sent to client)

                // ─── Store transport in peer data ───
                if (type==="send")
                {
                    peer.sendTransports.set(transport.id, transport);
                    // Store in send transports map
                } else
                {
                    peer.recvTransports.set(transport.id, transport);
                    // Store in receive transports map
                }

                // ─── Handle transport close event ───
                transport.on("close", () =>
                {
                    // When transport is closed (by us or mediasoup)
                    console.log(`Transport closed: ${transport.id}`);

                    // Remove from our tracking
                    peer.sendTransports.delete(transport.id);
                    peer.recvTransports.delete(transport.id);
                });

                // ─── Handle DTLS state changes ───
                transport.on("dtlsstatechange", (dtlsState) =>
                {
                    // DTLS = Datagram Transport Layer Security (encryption)
                    // States: new, connecting, connected, failed, closed

                    if (dtlsState==="failed"||dtlsState==="closed")
                    {
                        // If DTLS fails, the connection is unusable
                        console.error(`❌ Transport DTLS ${dtlsState}: ${transport.id}`);
                        transport.close();
                        // Close the transport to clean up
                    }
                });

                // ─── Handle ICE state changes ───
                transport.on("icestatechange", (iceState) =>
                {
                    // ICE = Interactive Connectivity Establishment
                    // How WebRTC finds the network path between peers
                    // States: new, checking, connected, completed, failed, disconnected, closed

                    if (iceState==="disconnected"||iceState==="closed")
                    {
                        // Connection lost or closed
                        console.warn(`Transport ICE ${iceState}: ${transport.id}`);
                        // Just log warning - might reconnect automatically
                    }
                });

                console.log(`${type} Transport created: ${transport.id}`);

                // ─── Send transport parameters to client ───
                callback(params);
                // params contains: id, iceParameters, iceCandidates, dtlsParameters
                // Client uses these to create local transport

            } catch (err)
            {
                console.log("createTransport error =>", err.message);
                callback({error: "Failed to create transport"});
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 3: CONNECT TRANSPORT
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: Client has created local transport and needs to connect it
        //
        // CLIENT SENDS:
        // - transportId: Which transport to connect
        // - dtlsParameters: Client's DTLS parameters for encryption handshake
        //
        // WHAT HAPPENS:
        // - Server and client do a DTLS handshake (like SSL/TLS)
        // - This secures the connection with encryption
        // - After this, media can flow
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("connectTransport", async ({transportId, dtlsParameters}, callback) =>
        {
            try
            {
                const peer=peers.get(socket.id);
                if (!peer) return callback({error: "Peer not found"});

                // ─── Connect the transport ───
                await connectTransport(transportId, dtlsParameters, peer.roomId, peer);
                // connectTransport() finds the transport and calls transport.connect()
                // This completes the DTLS handshake

                callback({connected: true});
                // Tell client connection succeeded

            } catch (err)
            {
                console.log("connectTransport error =>", err.message);
                callback({error: "DTLS connection failed"});
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 4: PRODUCE (Start sending audio/video)
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: Client wants to share their camera, microphone, or screen
        //
        // CLIENT SENDS:
        // - transportId: Which send transport to use
        // - kind: "audio" or "video"
        // - rtpParameters: Codec info for the media
        // - appData: Extra data (like "source": "screen" for screen share)
        //
        // SERVER RETURNS:
        // - id: The producer ID
        //
        // WHAT IS A PRODUCER?
        // - Represents media being SENT from client to server
        // - One producer per track (audio, video, screen share)
        // - Server stores the producer and forwards media to consumers
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("produce", async ({transportId, kind, rtpParameters, appData}, callback) =>
        {
            try
            {
                const peer=peers.get(socket.id);
                if (!peer) return callback({error: "Peer not found"});

                // ─── Get the send transport ───
                const transport=peer.sendTransports.get(transportId);
                if (!transport) return callback({error: "Send transport not found"});

                // ─── Create the producer on the transport ───
                const producer=await transport.produce({
                    kind,
                    // "audio" or "video"

                    rtpParameters,
                    // Codec settings from client
                    // Includes codecs, encodings, header extensions, etc.

                    appData: {...appData, peerId: socket.id},
                    // Custom data attached to producer
                    // We add peerId so we know who this producer belongs to
                    // ...appData copies any data client sent (like source: "screen")
                });

                // ─── Store producer in peer data ───
                peer.producers.set(producer.id, producer);

                // ─── Update peer state flags ───
                if (kind==="audio") peer.isAudioEnabled=true;
                // If producing audio, set flag to true

                if (kind==="video")
                {
                    if (appData?.source==="screen")
                    {
                        peer.isScreenSharing=true;
                        // If source is "screen", it's screen share
                    } else
                    {
                        peer.isVideoEnabled=true;
                        // Otherwise it's camera
                    }
                }

                // ─── Register producer in room for tracking ───
                registerProducer(peer.roomId, producer.id, socket.id, kind, peer.userName);
                // This allows new joiners to know about this producer

                console.log(`🎥 Producer created: ${producer.id} (${kind})`);

                // ─── Handle producer events ───
                producer.on("transportclose", () =>
                {
                    // If the transport closes, producer is automatically closed
                    console.log(`🎥 Producer transport closed: ${producer.id}`);
                    peer.producers.delete(producer.id);
                    unregisterProducer(peer.roomId, producer.id);
                });

                producer.on("close", () =>
                {
                    // Producer was closed (either by us or automatically)
                    console.log(`🎥 Producer closed: ${producer.id}`);
                    peer.producers.delete(producer.id);
                    unregisterProducer(peer.roomId, producer.id);

                    // Notify others that this producer is gone
                    notifyProducerClosed(peer.roomId, socket.id, producer.id);
                });

                // ─── Notify room about new producer ───
                notifyNewProducer(peer.roomId, socket.id, producer.id, kind, appData);
                // Tell everyone else there's a new stream they can consume

                callback({id: producer.id});
                // Return producer ID to client

            } catch (err)
            {
                console.log("produce error =>", err.message);
                callback({error: "Produce failed: "+err.message});
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 5: CONSUME (Start receiving audio/video)
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: Client wants to receive another user's camera/mic/screen
        //
        // CLIENT SENDS:
        // - producerId: Which producer to consume
        // - rtpCapabilities: What codecs client supports
        //
        // SERVER RETURNS:
        // - id: Consumer ID
        // - producerId: Which producer this is for
        // - kind: "audio" or "video"
        // - rtpParameters: Codec info for playback
        //
        // WHAT IS A CONSUMER?
        // - Represents media being RECEIVED by client from server
        // - Server creates a consumer for each producer you want to watch
        // - Consumer receives media from producer and sends to your speakers/screen
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("consume", async ({producerId, rtpCapabilities}, callback) =>
        {
            try
            {
                const peer=peers.get(socket.id);
                if (!peer) return callback({error: "Peer not found"});

                // ─── Get the router ───
                const router=getRouter(peer.roomId);
                if (!router) return callback({error: "Router not found"});

                console.log(`Consume request: producerId=${producerId}, roomId=${peer.roomId}`);

                // ─── Check if client can consume this producer ───
                const canConsume=router.canConsume({producerId, rtpCapabilities});
                // canConsume() checks:
                // 1. Does this producer exist on this router?
                // 2. Can the client's codecs decode this producer's codec?

                console.log(`canConsume: ${canConsume}`);

                if (!canConsume)
                {
                    console.log(`Cannot consume producer ${producerId} - checking if producer exists on router`);
                    return callback({error: "Cannot consume - codec mismatch or producer not found"});
                }

                // ─── Get receive transport ───
                const recvTransport=[...peer.recvTransports.values()][0];
                // Get the first (usually only) receive transport
                // [...Map.values()] converts Map values to array

                if (!recvTransport)
                {
                    return callback({error: "No receive transport available"});
                }

                // ─── Create consumer ───
                const consumer=await recvTransport.consume({
                    producerId,
                    // Which producer to consume

                    rtpCapabilities,
                    // Client's codec capabilities

                    paused: true,
                    // Start paused - client will resume after setup
                    // WHY: Prevents media arriving before client is ready
                    // This is a performance optimization
                });

                // ─── Store consumer ───
                peer.consumers.set(consumer.id, consumer);

                console.log(`Consumer created: ${consumer.id} for producer ${producerId}`);

                // ─── Handle consumer events ───
                consumer.on("transportclose", () =>
                {
                    // Transport closed, consumer is done
                    console.log(`Consumer transport closed: ${consumer.id}`);
                    peer.consumers.delete(consumer.id);
                });

                consumer.on("producerclose", () =>
                {
                    // The producer we're consuming was closed
                    console.log(`Consumer producer closed: ${consumer.id}`);
                    peer.consumers.delete(consumer.id);

                    // Tell client this consumer is done
                    socket.emit("consumerClosed", {consumerId: consumer.id});
                });

                consumer.on("producerpause", () =>
                {
                    // Producer paused (user muted)
                    socket.emit("consumerPaused", {consumerId: consumer.id});
                });

                consumer.on("producerresume", () =>
                {
                    // Producer resumed (user unmuted)
                    socket.emit("consumerResumed", {consumerId: consumer.id});
                });

                // ─── Return consumer info to client ───
                callback({
                    id: consumer.id,
                    producerId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                    producerPaused: consumer.producerPaused,
                });

            } catch (err)
            {
                console.log("consume error =>", err.message);
                callback({error: err.message||"Consume failed"});
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 6: RESUME CONSUMER
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: Client has set up the consumer track and is ready for media
        //
        // WHY SEPARATE FROM CONSUME?
        // - Consumer starts paused (see above)
        // - Client needs time to attach track to video element
        // - Once ready, client calls resumeConsumer
        // - Then media starts flowing
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("resumeConsumer", async ({consumerId}, callback) =>
        {
            try
            {
                const peer=peers.get(socket.id);
                if (!peer) return callback({error: "Peer not found"});

                const consumer=peer.consumers.get(consumerId);
                if (!consumer) return callback({error: "Consumer not found"});

                // ─── Resume the consumer ───
                await consumer.resume();
                // Now media will flow from producer → consumer → client

                console.log(`Consumer resumed: ${consumerId}`);

                callback({resumed: true});

            } catch (err)
            {
                console.log("resumeConsumer error =>", err.message);
                callback({error: "Resume failed"});
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 7: PAUSE/RESUME PRODUCER
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: User wants to mute/unmute their mic or disable/enable camera
        //
        // PAUSE: Stop sending media (mute)
        // RESUME: Start sending media again (unmute)
        //
        // NOTE: This is different from closing a producer
        // - Pause = temporarily stop, can resume later
        // - Close = permanently stop, have to create new producer
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("pauseProducer", async ({producerId}, callback) =>
        {
            try
            {
                const peer=peers.get(socket.id);
                if (!peer) return callback({error: "Peer not found"});

                const producer=peer.producers.get(producerId);
                if (!producer) return callback({error: "Producer not found"});

                // ─── Pause the producer ───
                await producer.pause();
                // Media stops flowing, but producer still exists

                console.log(`Producer paused: ${producerId}`);

                // ─── Update peer state ───
                if (producer.kind==="audio") peer.isAudioEnabled=false;
                if (producer.kind==="video") peer.isVideoEnabled=false;

                // ─── Notify others ───
                socket.to(peer.roomId).emit("producerPaused", {
                    producerId,
                    peerId: socket.id,
                    kind: producer.kind,
                });
                // Others can show "user is muted" in their UI

                callback({paused: true});

            } catch (err)
            {
                console.log("pauseProducer error =>", err.message);
                callback({error: "Pause failed"});
            }
        });

        socket.on("resumeProducer", async ({producerId}, callback) =>
        {
            try
            {
                const peer=peers.get(socket.id);
                if (!peer) return callback({error: "Peer not found"});

                const producer=peer.producers.get(producerId);
                if (!producer) return callback({error: "Producer not found"});

                // ─── Resume the producer ───
                await producer.resume();
                // Media starts flowing again

                console.log(`Producer resumed: ${producerId}`);

                // ─── Update peer state ───
                if (producer.kind==="audio") peer.isAudioEnabled=true;
                if (producer.kind==="video") peer.isVideoEnabled=true;

                // ─── Notify others ───
                socket.to(peer.roomId).emit("producerResumed", {
                    producerId,
                    peerId: socket.id,
                    kind: producer.kind,
                });
                // Others can show "user is unmuted" in their UI

                callback({resumed: true});

            } catch (err)
            {
                console.log("resumeProducer error =>", err.message);
                callback({error: "Resume failed"});
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 8: CLOSE PRODUCER (Stop sending media completely)
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: User wants to completely stop sharing camera/mic/screen
        //
        // DIFFERENCE FROM PAUSE:
        // - Pause = temporary, can resume
        // - Close = permanent, must create new producer to share again
        //
        // EXAMPLE: User clicks "Stop sharing screen"
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("closeProducer", async ({producerId}, callback) =>
        {
            try
            {
                const peer=peers.get(socket.id);
                if (!peer) return callback({error: "Peer not found"});

                const producer=peer.producers.get(producerId);
                if (!producer) return callback({error: "Producer not found"});

                // ─── Update peer state before closing ───
                if (producer.kind==="audio") peer.isAudioEnabled=false;

                if (producer.kind==="video")
                {
                    const appData=producer.appData;
                    if (appData?.source==="screen")
                    {
                        peer.isScreenSharing=false;
                        // It was screen share
                    } else
                    {
                        peer.isVideoEnabled=false;
                        // It was camera
                    }
                }

                // ─── Close the producer ───
                producer.close();
                // This triggers "close" event on all consumers of this producer
                // They'll receive "consumerClosed" event

                peer.producers.delete(producerId);
                // Remove from our tracking

                unregisterProducer(peer.roomId, producerId);
                // Remove from room's producer list

                console.log(`🎥 Producer closed by client: ${producerId}`);

                callback({closed: true});

            } catch (err)
            {
                console.log("closeProducer error =>", err.message);
                callback({error: "Close failed"});
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 9: PAUSE CONSUMER
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: Client wants to temporarily stop receiving a stream
        //
        // EXAMPLE: User minimizes a participant's video
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("pauseConsumer", async ({consumerId}, callback) =>
        {
            try
            {
                const peer=peers.get(socket.id);
                if (!peer) return callback({error: "Peer not found"});

                const consumer=peer.consumers.get(consumerId);
                if (!consumer) return callback({error: "Consumer not found"});

                await consumer.pause();
                // Stop receiving this stream (saves bandwidth)

                console.log(`Consumer paused: ${consumerId}`);

                callback({paused: true});

            } catch (err)
            {
                console.log("pauseConsumer error =>", err.message);
                callback({error: "Pause failed"});
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 10: GET ROOM STATS
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: Client wants to see room statistics
        //
        // RETURNS:
        // - stats: Room info (peer count, producer count, etc.)
        // - participants: List of all participants
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("getRoomStats", async ({roomId}, callback) =>
        {
            try
            {
                const stats=getRoomStats(roomId);
                const participants=getParticipantsInRoom(roomId);
                callback({stats, participants});
            } catch (err)
            {
                callback({error: err.message});
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 11: HAND RAISE TOGGLE
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: User wants to raise/lower their hand
        //
        // FEATURE: In meetings, users can "raise hand" to get attention
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("toggleHandRaise", async (data, callback) =>
        {
            try
            {
                const peer=peers.get(socket.id);
                if (!peer) return callback({error: "Peer not found"});

                // ─── Toggle the hand raised state ───
                peer.isHandRaised=!peer.isHandRaised;
                // If true, becomes false. If false, becomes true.

                // ─── Notify room ───
                socket.to(peer.roomId).emit("handRaiseChanged", {
                    peerId: socket.id,
                    isHandRaised: peer.isHandRaised,
                });
                // Others can show hand raised icon next to user

                callback({isHandRaised: peer.isHandRaised});

            } catch (err)
            {
                callback({error: err.message});
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 12: CHAT MESSAGE
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: User sends a chat message in the room
        //
        // FLOW:
        // 1. Receive message from sender
        // 2. Add metadata (who, when)
        // 3. Broadcast to everyone in room
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("chatMessage", async ({message}, callback) =>
        {
            try
            {
                const peer=peers.get(socket.id);
                if (!peer) return callback({error: "Peer not found"});

                // ─── Create chat message object ───
                const chatMessage={
                    id: Date.now().toString(),
                    // Unique ID for this message (timestamp)

                    peerId: socket.id,
                    // Who sent it

                    userName: peer.userName,
                    // Their display name

                    message,
                    // The actual message text

                    timestamp: Date.now(),
                    // When it was sent
                };

                // ─── Broadcast to everyone in room (including sender) ───
                io.to(peer.roomId).emit("newChatMessage", chatMessage);
                // io.to() sends to ALL sockets in the room (including sender)
                // Different from socket.to() which excludes sender

                callback({sent: true});

            } catch (err)
            {
                callback({error: err.message});
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 13: GET EXISTING PRODUCERS (for late joiners)
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: User joined room and wants to see all active streams
        //
        // NOTE: This is also returned in joinRoom, but client can
        // request it again if needed
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("getExistingProducers", async (data, callback) =>
        {
            try
            {
                const peer=peers.get(socket.id);
                if (!peer) return callback({error: "Peer not found"});

                const existingProducers=getOtherProducers(peer.roomId, socket.id);
                callback({producers: existingProducers});

            } catch (err)
            {
                callback({error: err.message});
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 14: SET CONSUMER PREFERRED LAYERS (for simulcast)
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHAT IS SIMULCAST?
        // - Sender sends multiple quality versions of video
        // - Low (r0), Medium (r1), High (r2)
        // - Receiver can choose which quality to receive
        //
        // WHEN: Client wants to change video quality
        //
        // EXAMPLE: Low bandwidth? Request spatialLayer: 0 (low quality)
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("setConsumerPreferredLayers", async ({consumerId, spatialLayer, temporalLayer}, callback) =>
        {
            try
            {
                const peer=peers.get(socket.id);
                if (!peer) return callback({error: "Peer not found"});

                const consumer=peer.consumers.get(consumerId);
                if (!consumer) return callback({error: "Consumer not found"});

                // ─── Set preferred layers ───
                await consumer.setPreferredLayers({spatialLayer, temporalLayer});
                // spatialLayer: 0 = low, 1 = medium, 2 = high (resolution)
                // temporalLayer: Frame rate quality

                console.log(`📊 Consumer layers set: ${consumerId} -> spatial=${spatialLayer}, temporal=${temporalLayer}`);

                callback({success: true});

            } catch (err)
            {
                callback({error: err.message});
            }
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 15: DISCONNECT (User closes browser or loses connection)
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: Socket connection is lost
        //
        // CAUSES:
        // - User closes browser tab
        // - Network disconnection
        // - Server restart
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("disconnect", () =>
        {
            // Socket.IO automatically fires this when connection is lost
            cleanupPeer(socket.id);
            // Clean up all resources for this user
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 16: LEAVE ROOM (User manually leaves)
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: User clicks "Leave" button
        //
        // DIFFERENCE FROM DISCONNECT:
        // - Leave = intentional, user clicked button
        // - Disconnect = could be accidental (network issue)
        // - Both do the same cleanup
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("leaveRoom", (data, callback) =>
        {
            cleanupPeer(socket.id);
            if (callback) callback({left: true});
        });

        // ═══════════════════════════════════════════════════════════════════
        // EVENT 17: END MEETING FOR ALL (Owner only)
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHEN: Room owner clicks "End meeting for all"
        //
        // WHAT HAPPENS:
        // 1. Verify caller is the owner
        // 2. Tell everyone the meeting is ending
        // 3. Clean up all participants
        // 4. Delete the room
        //
        // ═══════════════════════════════════════════════════════════════════

        socket.on("endMeeting", ({roomId}, callback) =>
        {
            const peer=peers.get(socket.id);
            if (!peer)
            {
                return callback?.({error: "Peer not found"});
                // callback?.() = only call if callback exists
            }

            // ─── Verify owner ───
            const ownerSocketId=roomOwners.get(roomId);
            if (ownerSocketId!==socket.id)
            {
                return callback?.({error: "Only the host can end the meeting"});
            }

            console.log(`Meeting ended by owner in room ${roomId}`);

            // ─── Notify everyone that meeting is ending ───
            socket.to(roomId).emit("meetingEnded", {
                reason: "Host ended the meeting",
            });
            // Clients will show "Meeting has ended" and redirect

            // ─── Clean up all peers in the room ───
            const roomPeers=rooms.get(roomId);
            if (roomPeers)
            {
                for (const peerId of roomPeers)
                {
                    if (peerId!==socket.id)
                    {
                        // Clean up everyone except owner (we'll do owner last)
                        cleanupPeer(peerId);
                    }
                }
            }

            // ─── Clean up the owner ───
            cleanupPeer(socket.id);

            // ─── Remove room owner tracking ───
            roomOwners.delete(roomId);

            if (callback) callback({ended: true});
        });
    });
    // End of io.on("connection") handler
}

// =========================================================
// HELPER FUNCTIONS
// =========================================================

function cleanupPeer(socketId)
{
    const peer=peers.get(socketId);
    if (!peer) return;

    const roomId=peer.roomId;

    // Close all consumers
    peer.consumers.forEach((consumer) =>
    {
        try {consumer.close();} catch (e) {}
    });

    // Close all producers
    peer.producers.forEach((producer) =>
    {
        try
        {
            unregisterProducer(roomId, producer.id);
            producer.close();
        } catch (e) {}
    });

    // Close all transports
    peer.sendTransports.forEach((transport) =>
    {
        try {transport.close();} catch (e) {}
    });

    peer.recvTransports.forEach((transport) =>
    {
        try {transport.close();} catch (e) {}
    });

    // Remove from room tracking
    const roomPeers=rooms.get(roomId);
    if (roomPeers)
    {
        roomPeers.delete(socketId);
        console.log(`User left room ${roomId} (${roomPeers.size} peers remaining)`);

        // Notify room about user leaving
        peer.socket.to(roomId).emit("participantLeft", {
            peerId: socketId,
            userId: peer.userId,
        });

        // Cleanup empty rooms
        if (roomPeers.size===0)
        {
            cleanupRoom(roomId);
            rooms.delete(roomId);
            roomOwners.delete(roomId);
            console.log(`Room ${roomId} cleaned up (empty)`);
        }
    }

    peers.delete(socketId);
    console.log("USER DISCONNECTED:", socketId);
}

function getParticipantsInRoom(roomId, excludeSocketId=null)
{
    const roomPeers=rooms.get(roomId);
    if (!roomPeers) return [];

    const participants=[];
    for (const peerId of roomPeers)
    {
        if (peerId!==excludeSocketId)
        {
            const peer=peers.get(peerId);
            if (peer)
            {
                participants.push(peer.toPublicData());
            }
        }
    }
    return participants;
}

function notifyNewProducer(roomId, senderSocketId, producerId, kind, appData={})
{
    const roomPeers=rooms.get(roomId);
    if (!roomPeers) return;

    // Get sender's userName
    const senderPeer=peers.get(senderSocketId);
    const senderUserName=senderPeer?.userName||"Anonymous";

    for (const peerId of roomPeers)
    {
        if (peerId!==senderSocketId)
        {
            const peer=peers.get(peerId);
            if (peer)
            {
                peer.socket.emit("newProducer", {
                    producerId,
                    peerId: senderSocketId,
                    kind,
                    appData,
                    userName: senderUserName,
                });
            }
        }
    }
}

function notifyProducerClosed(roomId, senderSocketId, producerId)
{
    const roomPeers=rooms.get(roomId);
    if (!roomPeers) return;

    for (const peerId of roomPeers)
    {
        if (peerId!==senderSocketId)
        {
            const peer=peers.get(peerId);
            if (peer)
            {
                peer.socket.emit("producerClosed", {
                    producerId,
                    peerId: senderSocketId,
                });
            }
        }
    }
}
