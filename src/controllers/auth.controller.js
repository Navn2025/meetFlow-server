import userModel from "../model/user.model.js";
import jwt from "jsonwebtoken";
import bcrypt from 'bcryptjs'

export const registerController=async (req, res) =>
{
    try
    {


        const {name, email, password, preferred_language, preferred_voice}=req.body;
        if (!name)
        {
            return res.status(401).json({
                message: "Name is required",
            });
        }
        if (!email)
        {
            return res.status(401).json({
                message: "Email is required",
            });
        }
        if (!password)
        {
            return res.status(401).json({
                message: "Password is required",
            });
        }
        if (!preferred_language)
        {
            return res.status(401).json({
                message: "Preferred languuage is required",
            });
        }
        const existingUser=await userModel.findOne({
            email
        });
        if (existingUser)
        {
            return res.status(401).json({
                message: "User Already Exists",
            });

        }
        const hashedPassword=await bcrypt.hash(password, 10);
        const user=await userModel.create({
            email,
            name,
            password: hashedPassword,
            preferred_language,
            preferred_voice
        });
        if (!user)
        {
            return res.status(401).json({
                message: "User Creation Unsuccessfull"
            })
        }
        const userResponse=user.toObject();
        delete userResponse.password;
        const token=jwt.sign({id: user._id}, process.env.JWT_SECRET, {
            expiresIn: "7d",
        });
        res.cookie("token", token);
        return res.status(200).json({
            message: "User Created Successfully",
            user: userResponse,
            token
        });
    } catch (error)
    {
        return res.status(404).json({
            message: "Error in creating User",
            error
        })
    }
}
export const loginController=async (req, res) =>
{
    try
    {


        const {email, password}=req.body;
        if (!email)
        {
            return res.status(401).json({
                message: "Email is required"
            })
        }
        if (!password)
        {
            return res.status(401).json({
                message: "Password is required"
            });
        }
        const userExists=await userModel.findOne({
            email
        }).select("+password");
        if (!userExists)
        {
            return res.status(401).json({
                message: "User Doesnt exists"
            });

        }
        const isPasswordValid=await bcrypt.compare(password, userExists.password)
        if (!isPasswordValid)
        {
            return res.status(400).json({
                message: "Incorrect Password"
            })
        }
        const userResponse=userExists.toObject();
        delete userResponse.password;
        const token=jwt.sign({id: userExists._id}, process.env.JWT_SECRET, {
            expiresIn: "7d",
        });
        res.cookie("token", token);
        return res.status(200).json({
            message: "User Created Successfully",
            user: userResponse,
            token
        });
    } catch (error)
    {
        console.log(error);
        return res.status(404).json({
            message: "Error in Login",
            error
        });


    }
}
export const currentUser=async (req, res) =>
{
    try
    {


        const {id}=req.user;
        const user=await userModel.findById(id);
        if (!user)
        {
            return res.status(401).json({
                message: "User Not exists"
            })
        }

        return res.status(200).json({
            message: "current user fetched successfully",
            user
        })
    } catch (error)
    {
        console.error('Error:', error);
        return res.status(500).json({
            message: "Error in fetching user"
        })
    }
}