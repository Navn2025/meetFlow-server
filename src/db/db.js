import {connect} from "mongoose";
async function connectToDB()
{
    try
    {
        await connect(process.env.MONGODB_URI)
        console.log("✔️ CONNECTED TO DATABASE");
    } catch (error)
    {
        console.error('Error in connecting to database', error);
    }
}
export default connectToDB