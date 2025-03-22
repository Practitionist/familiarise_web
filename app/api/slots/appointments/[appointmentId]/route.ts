import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, AppointmentsType } from "@prisma/client";

interface UpdateSlotsRequest {
  slotsOfAppointment?: {
    deleteMany?: Record<string, never>;
    createMany?: {
      data: Array<{
        slotStartTimeInUTC: string;
        slotEndTimeInUTC: string;
      }>;
    };
  };
}

interface UpdateAppointmentRequest {
  appointmentType?: AppointmentsType;
  slotsOfAppointmentId?: string;
  consultationId?: string;
  subscriptionId?: string;
  webinarId?: string;
  classId?: string;
}

type AppointmentInclude = Prisma.AppointmentGetPayload<{
  include: {
    slotsOfAppointment: {
      include: {
        user: {
          select: {
            id: true;
            name: true;
            email: true;
            image: true;
            consulteeProfile: true;
          };
        };
      };
    };
    consultation: {
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    id: true;
                    name: true;
                    email: true;
                    image: true;
                  };
                };
              };
            };
          };
        };
        requestedBy: {
          include: {
            user: {
              select: {
                id: true;
                name: true;
                email: true;
                image: true;
              };
            };
          };
        };
      };
    };
    subscription: {
      include: {
        subscriptionPlan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    id: true;
                    name: true;
                    email: true;
                    image: true;
                  };
                };
              };
            };
          };
        };
        requestedBy: {
          include: {
            user: {
              select: {
                id: true;
                name: true;
                email: true;
                image: true;
              };
            };
          };
        };
      };
    };
    webinar: {
      include: {
        webinarPlan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    id: true;
                    name: true;
                    email: true;
                    image: true;
                  };
                };
              };
            };
          };
        };
      };
    };
    class: {
      include: {
        classPlan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    id: true;
                    name: true;
                    email: true;
                    image: true;
                  };
                };
              };
            };
          };
        };
      };
    };
  };
}>;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const { appointmentId } = await params;
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        slotsOfAppointment: {
          include: {
            user: {
              // Changed from consulteeProfile
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                consulteeProfile: true, // Include consulteeProfile if needed
              },
            },
          },
        },
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
        webinar: {
          include: {
            webinarPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        class: {
          include: {
            classPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        payment: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: appointment }, { status: 200 });
  } catch (error) {
    console.error("Error fetching appointment:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the appointment" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const rawParams = await params;
    console.log("Raw params:", JSON.stringify(rawParams));
    
    const { appointmentId } = rawParams;
    console.log("Extracted appointmentId:", appointmentId);
    
    const rawBody = await request.text();
    console.log("Raw request body:", rawBody);
    
    const body: UpdateSlotsRequest = JSON.parse(rawBody);
    console.log("Parsed body:", JSON.stringify(body, null, 2));

    if (!body.slotsOfAppointment?.createMany?.data) {
      return NextResponse.json(
        { error: "Missing slots data" },
        { status: 400 },
      );
    }

    console.log("Number of slots to update:", body.slotsOfAppointment.createMany.data.length);

    // Validate that we can parse all dates correctly
    const slotData = body.slotsOfAppointment.createMany.data.map((slot) => {
      try {
        return {
          slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC),
          slotEndTimeInUTC: new Date(slot.slotEndTimeInUTC),
        };
      } catch (error) {
        console.error("Error parsing dates:", error);
        console.error("Problem slot:", slot);
        throw new Error(`Invalid date format in slots: ${JSON.stringify(slot)}`);
      }
    });
    
    const data: Prisma.AppointmentUpdateInput = {
      slotsOfAppointment: {
        deleteMany: {},
        create: slotData,
      },
    };

    console.log("Looking for appointment with id:", appointmentId);
    const existingAppointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
    });
    
    if (!existingAppointment) {
      console.log("No appointment found with id:", appointmentId);
      return NextResponse.json(
        { error: `Appointment not found with id: ${appointmentId}` },
        { status: 404 },
      );
    }
    
    console.log("Found existing appointment:", JSON.stringify(existingAppointment, null, 2));
    console.log("Updating with data:", JSON.stringify(data, null, 2));

    const updatedAppointment = await prisma.appointment.update({
      where: { id: appointmentId },
      data,
      include: {
        slotsOfAppointment: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                consulteeProfile: true,
              },
            },
          },
        },
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
        webinar: {
          include: {
            webinarPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        class: {
          include: {
            classPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    console.log(updatedAppointment);

    return NextResponse.json({ data: updatedAppointment }, { status: 200 });
  } catch (error) {
    console.error("Error updating appointment slots:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Appointment not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while updating the appointment slots" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const { appointmentId } = await params;
    const body: UpdateAppointmentRequest = await request.json();

    if (
      body.appointmentType &&
      !Object.values(AppointmentsType).includes(body.appointmentType)
    ) {
      return NextResponse.json(
        { error: "Invalid appointment type" },
        { status: 400 },
      );
    }

    const data: Prisma.AppointmentUpdateInput = {
      appointmentType: body.appointmentType,
      consultation: body.consultationId
        ? { connect: { id: body.consultationId } }
        : undefined,
      subscription: body.subscriptionId
        ? { connect: { id: body.subscriptionId } }
        : undefined,
      webinar: body.webinarId ? { connect: { id: body.webinarId } } : undefined,
      class: body.classId ? { connect: { id: body.classId } } : undefined,
    };

    const updatedAppointment = await prisma.appointment.update({
      where: { id: appointmentId },
      data,
      include: {
        slotsOfAppointment: {
          include: {
            user: {
              // Changed from consulteeProfile
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                consulteeProfile: true, // Include consulteeProfile if needed
              },
            },
          },
        },
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
        webinar: {
          include: {
            webinarPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        class: {
          include: {
            classPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        payment: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: updatedAppointment }, { status: 200 });
  } catch (error) {
    console.error("Error updating appointment:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Appointment not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while updating the appointment" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const { appointmentId } = await params;
    // Check if there's an associated payment
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        payment: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
      },
    });

    if (appointment?.payment) {
      return NextResponse.json(
        { error: "Cannot delete appointment with associated payment" },
        { status: 400 },
      );
    }

    const deletedAppointment = await prisma.appointment.delete({
      where: { id: appointmentId },
      include: {
        slotsOfAppointment: {
          include: {
            user: {
              // Changed from consulteeProfile
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                consulteeProfile: true, // Include consulteeProfile if needed
              },
            },
          },
        },
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
        webinar: {
          include: {
            webinarPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        class: {
          include: {
            classPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: deletedAppointment }, { status: 200 });
  } catch (error) {
    console.error("Error deleting appointment:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Appointment not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while deleting the appointment" },
      { status: 500 },
    );
  }
}
