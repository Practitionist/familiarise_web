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


// this only updates the slots of the appointment
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const { appointmentId } = await params;
    const body: UpdateSlotsRequest = await request.json();

    if (!body.slotsOfAppointment?.createMany?.data) {
      return NextResponse.json(
        { error: "Missing slots data" },
        { status: 400 },
      );
    }

    const data: Prisma.AppointmentUpdateInput = {
      slotsOfAppointment: {
        deleteMany: {},
        create: body.slotsOfAppointment.createMany.data.map((slot) => ({
          slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC),
          slotEndTimeInUTC: new Date(slot.slotEndTimeInUTC),
        })),
      },
    };

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


// this updates the appointments but not the slot times
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
    // Check if there's an associated appointment
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
