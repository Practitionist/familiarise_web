import { TConsultantProfile } from "@/types/consultant";
import { ApiResponse } from "../types";

export async function fetchConsultantData(
  consultantId: string,
): Promise<TConsultantProfile> {
  try {
    const response = await fetch(`/api/user/consultants/${consultantId}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch consultant data: ${response.statusText}`,
      );
    }
    const data: ApiResponse<TConsultantProfile> = await response.json();
    return data.data;
  } catch (error) {
    console.error("Error fetching consultant data:", error);
    throw error;
  }
}
