import participantModel from "../model/participant.model.js";
import roomModel from "../model/room.model.js";

export const roomCreate=async (req, res) =>
{
    try
    {
        const {name}=req.body;
        const userId=req.user.id;

        // 1️⃣ Validate room name
        if (!name||name.trim()==="")
        {
            return res.status(400).json({
                success: false,
                message: "Room name is required",
            });
        }

        // 2️⃣ Check if the user already created a room with same name
        const existingRoom=await roomModel.findOne({
            name: name.trim(),
            createdBy: userId,
        });

        if (existingRoom)
        {
            return res.status(409).json({
                success: false,
                message: "Room already exists for this user",
            });
        }

        // 3️⃣ Create room and add creator as participant
        const room=await roomModel.create({
            name: name.trim(),
            createdBy: userId,
            participants: [userId],
        });

        if (!room)
        {
            return res.status(500).json({
                success: false,
                message: "Error creating room",
            });
        }

        // 4️⃣ Return success
        return res.status(201).json({
            success: true,
            message: "Room created successfully",
            room,
        });
    } catch (error)
    {
        console.error("Error in creating room:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while creating room",
            error: error.message,
        });
    }
};

export const getAllRoom=async (req, res) =>
{
    try
    {
        const rooms=await roomModel.find({
            createdBy: req.user.id
        });
        if (!rooms)
        {
            return res.status(401).json({
                message: "No room is created by user"
            });
        };
        return res.status(200).json({
            message: "Room fetched successfully",
            rooms
        });

    } catch (error)
    {
        return res.status(400).json({
            message: "Error in fetching room"
        });

    }

}
export const getRoomsById=async (req, res) =>
{
    const {id}=req.params;
    const roomId=id;
    if (!roomId)
    {
        return res.status(400).json({
            message: "Room id is reqd"
        })
    }
    const room=await roomModel.findOne({
        _id: roomId
    })
    if (!room)
    {
        return res.status(400).json({
            message: "room not found"
        });
    }
    if (room.createdBy!=req.user.id)
    {
        return res.status(400).json({
            message: "Unauthorized"
        });

    }
    return res.status(200).json({
        message: "Room fetched Successfully",
        room
    });

}
export const endRoom=async (req, res) =>
{
    const {id}=req.params;

    const room=await roomModel.findById(id);
    if (!room)
    {
        return res.status(400).json({
            message: "No room exists"
        });
    }
    if (room.createdBy!=req.user.id)
    {
        return res.status(401).json({
            message: "unauthorized"
        })
    }
    const roomDel=await roomModel.findByIdAndDelete(id);
    const participant=await participantModel.findOneAndDelete({
        roomId: id
    })

    return res.status(200).json({
        message: "Room ended Successfully",
        roomDel,
        participant
    })
}