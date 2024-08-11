import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest,
    params: { id: string }) {
    try {
        // TODO: We are using findFirst here, but we should use findUnique
        // to get the consultant by the user id

        const consultant = await prisma.consultantProfile.findFirst({
            where: { id: params.id }
        });
        return NextResponse.json(consultant, { status: 200 });

    } catch (error) {
        console.error(error);
        return NextResponse.json(error, { status: 500 });
    }
}


export async function POST(req: NextRequest,
    params: { id: string }) {

    try {
        const body = await req.json();

        const consultant = await prisma.consultantProfile.create({
            data: {
                scheduleType: body.scheduleType,
                rating: body.rating,
                specialization: body.specialization,
                experience: body.experience,
                location: body.location,
                onlineStatus: body.onlineStatus,
                domain: body.domain,
                subDomains: body.subDomains,
                userId: params.id
            }
        });

        return NextResponse.json(consultant, { status: 200 });
    }
    catch (error) {
        console.error(error);
        return NextResponse.json(error, { status: 500 });
    }
}



export async function PUT(req: NextRequest,
    params: { id: string }) {
    try {
        const body = await req.json();

        const consultant = await prisma.consultantProfile.update({
            where: {
                id: params.id,
            },
            data: {
                scheduleType: body.scheduleType,
                rating: body.rating,
                specialization: body.specialization,
                experience: body.experience,
                location: body.location,
                onlineStatus: body.onlineStatus,
                domain: body.domain,
                subDomains: body.subDomains,
            }
        });

        return NextResponse.json(consultant, { status: 200 });
    } catch (error) {
        console.error(error);
        return NextResponse.json(error, { status: 500 });
    }
}
export async function DELETE(req: NextRequest,
    params: { id: string }) {
    try {
        const consultant = await prisma.consultantProfile.delete({
            where: {
                id: params.id,
            }
        });

        return NextResponse.json(consultant, { status: 200 });
    } catch (error) {
        console.error(error);
        return NextResponse.json(error, { status: 500 });
    }
}
