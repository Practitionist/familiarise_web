import { useUserData } from "@/hooks/useUserData"
import { Call, useStreamVideoClient } from "@stream-io/video-react-sdk";
import { useRouter } from "next/navigation";
import { useState } from "react";

const {userDetails,isLoading} = useUserData(userId); 


const client = useStreamVideoClient();
const [values, setValues] = useState({
    title: "",
    dateTime: new Date(),
    description: "",
    link: "",
});
const [callDetails, setCallDetails] = useState<Call>();
const router = useRouter();

export const createMeeting = async () => {
    if (!client) {
        throw new Error("Stream client not initialized");
    }

    if (!userDetails) {
        throw new Error("User details not found");
    }


    try{
        const id = crypto.randomUUID();
        const call = client.call("default", id);

        if (!call) {
            throw new Error("Failed to create call");
        }

        const startsAt = values.dateTime.toISOString() ?? new Date(Date.now()).toISOString();
        const description = values.description ?? "Instant Meeting";
   
   
        await call.getOrCreate({
            data: {
                starts_at: startsAt,
                custom: {
                    title: values.title,
                    description: description,
                    link: values.link,
                },
            },
        })

        setCallDetails(call);

        if (!values.description) {
            router.push(`/meeting/${id}`);
        }
            
   
   
    } catch (error) {
        console.error("Error creating meeting:", error);
        throw error;
    }
}   