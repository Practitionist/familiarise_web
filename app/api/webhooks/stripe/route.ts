import prisma from "@/lib/prisma";
import {
  OrderStatus,
  PaymentStatus,
  ProductType,
  RequestStatus,
  AppointmentsType,
  Prisma,
} from "@prisma/client";
import { NextResponse } from "next/server";
import Stripe from "stripe";

// Define a specific type for the planSnapshot for consultations
interface ConsultationPlanSnapshot {
  slotId?: string; // Can be undefined if not found or not applicable
  consultationId?: string; // Can be undefined if creating a new one
}

// Define a specific type for the planSnapshot for webinars
interface WebinarPlanSnapshot {
  webinarId?: string; // ID of the specific Webinar (instance/session)
}

// Define a specific type for the planSnapshot for classes
interface ClassPlanSnapshot {
  classId?: string; // ID of the specific Class (instance/session)
}

// Define a specific type for the planSnapshot for subscriptions
interface SubscriptionPlanSnapshot {
  // This interface is for type casting the planSnapshot for subscriptions.
  // Add specific fields here if the snapshot for subscriptions needs to carry unique data.
  _placeholder?: unknown; // Ensures the interface is not considered empty by linters.
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
});

export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "No signature found" }, { status: 400 });
  }

  try {
    const body = await req.text();
    const event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );

    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object as Stripe.PaymentIntent & {
        charges: {
          data: Array<{
            receipt_url: string;
          }>;
        };
      };

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // 1. Update Payment status
        const updatedPayment = await tx.payment.updateMany({
          where: { paymentIntent: paymentIntent.id },
          data: {
            paymentStatus: PaymentStatus.SUCCEEDED,
            receiptUrl: paymentIntent.charges.data[0]?.receipt_url,
          },
        });

        if (updatedPayment.count === 0) {
          console.error(`Stripe Webhook: No payment record found to update for paymentIntent ${paymentIntent.id}`);
          throw new Error(`Payment record not found for paymentIntent ${paymentIntent.id}`);
        }

        // Retrieve the payment record to get orderId
        const paymentRecord = await tx.payment.findFirst({
          where: { paymentIntent: paymentIntent.id },
        });

        if (!paymentRecord?.orderId) {
          console.error(`Stripe Webhook: Payment record not found or orderId missing for paymentIntent ${paymentIntent.id}`);
          throw new Error(`Payment record not found or orderId missing after update for paymentIntent ${paymentIntent.id}`);
        }

        // 2. Update Order status
        const order = await tx.order.update({
          where: { id: paymentRecord.orderId },
          data: { status: OrderStatus.COMPLETED },
          include: { items: true }, // Include items for fulfillment
        });

        if (!order) {
          console.error(`Stripe Webhook: Order not found for orderId ${paymentRecord.orderId}`);
          throw new Error(`Order not found: ${paymentRecord.orderId}`);
        }

        // 3. Process OrderItems for fulfillment
        for (const item of order.items) {
          const planSnapshot = item.planSnapshot;

          switch (item.productType) {
            case ProductType.CONSULTATION: {
              if (planSnapshot && typeof planSnapshot === "object") {
                const typedPlanSnapshot = planSnapshot as ConsultationPlanSnapshot;
                const slotId = typedPlanSnapshot.slotId;
                let consultationId = typedPlanSnapshot.consultationId;

                if (!slotId) {
                  console.error(`Stripe Webhook: slotId missing in planSnapshot for consultation OrderItem ${item.id} in Order ${order.id}. Skipping fulfillment for this item.`);
                  continue; // Skip this item if slotId is crucial and missing
                }

                // Step 1: Create an Appointment record
                const appointment = await tx.appointment.create({
                  data: {
                    appointmentType: AppointmentsType.CONSULTATION,
                  },
                });
                const appointmentId = appointment.id;

                // Step 2: Update SlotOfAppointment
                await tx.slotOfAppointment.update({
                  where: { id: slotId },
                  data: {
                    appointmentId: appointmentId,
                    isTentative: false,
                  },
                });

                // Step 3: Handle Consultation record
                if (consultationId) {
                  await tx.consultation.update({
                    where: { id: consultationId },
                    data: {
                      requestStatus: RequestStatus.APPROVED,
                      appointment: { connect: { id: appointmentId } },
                      Order: { connect: { id: order.id } },
                    },
                  });
                  // Ensure order is linked if it wasn't (defensive)
                  if (order.consultationId !== consultationId) {
                    await tx.order.update({
                      where: { id: order.id },
                      data: { consultationId: consultationId }
                    });
                  }
                } else {
                  const consulteeProfile = await tx.consulteeProfile.findUnique({
                    where: { userId: order.userId },
                    select: { id: true },
                  });

                  if (!consulteeProfile) {
                    console.error(`Stripe Webhook: ConsulteeProfile not found for userId ${order.userId} for Order ${order.id}. Cannot create Consultation.`);
                    throw new Error(`ConsulteeProfile not found for userId ${order.userId}, cannot fulfill consultation.`);
                  }

                  const newConsultation = await tx.consultation.create({
                    data: {
                      consultationPlanId: item.planId,
                      requestStatus: RequestStatus.APPROVED,
                      requestedById: consulteeProfile.id,
                      requestedAt: new Date(),
                      directlyBooked: true,
                      appointment: { connect: { id: appointmentId } },
                      Order: { connect: { id: order.id } },
                    },
                  });
                  consultationId = newConsultation.id;

                  await tx.order.update({
                    where: { id: order.id },
                    data: { consultationId: consultationId },
                  });
                }
                
                // Step 4: Link Appointment back to Consultation
                await tx.appointment.update({
                  where: {id: appointmentId},
                  data: { consultationId: consultationId }
                });

                console.log(`Stripe Webhook: Consultation ${consultationId} for Order ${order.id}, Item ${item.id} fulfilled. Slot ${slotId} booked via Appointment ${appointmentId}.`);
              } else {
                 console.error(`Stripe Webhook: planSnapshot is missing or not an object for consultation OrderItem ${item.id} in Order ${order.id}. Skipping fulfillment for this item.`);
              }
              break;
            }
            case ProductType.CLASS: {
              if (planSnapshot && typeof planSnapshot === 'object') {
                const typedPlanSnapshot = planSnapshot as ClassPlanSnapshot;
                const classId = typedPlanSnapshot.classId;

                if (!classId) {
                  console.error(`Stripe Webhook: classId missing in planSnapshot for class OrderItem ${item.id} in Order ${order.id}. Skipping fulfillment for this item.`);
                  continue; // Skip this item if classId is crucial and missing
                }

                // Create ClassRegistration
                const classRegistration = await tx.classRegistration.create({
                  data: {
                    userId: order.userId,
                    classId: classId, // Link to the specific Class instance
                    classPlanId: item.planId, // Link to the ClassPlan
                    orderId: order.id, // Link to the Order (this establishes the unique constraint)
                    status: "CONFIRMED", // Or a more appropriate status enum/value
                  },
                });

                // Update the Order with the classRegistrationId
                // This is for the 1:1 relation from Order -> ClassRegistration
                await tx.order.update({
                  where: { id: order.id },
                  data: { classRegistrationId: classRegistration.id },
                });

                console.log(`Stripe Webhook: ClassRegistration ${classRegistration.id} for Order ${order.id}, Item ${item.id} (Class ${classId}) fulfilled.`);
              } else {
                console.error(`Stripe Webhook: planSnapshot is missing or not an object for class OrderItem ${item.id} in Order ${order.id}. Skipping fulfillment for this item.`);
              }
              break;
            }
            case ProductType.WEBINAR: {
              if (planSnapshot && typeof planSnapshot === 'object') {
                const typedPlanSnapshot = planSnapshot as WebinarPlanSnapshot;
                const webinarId = typedPlanSnapshot.webinarId;

                if (!webinarId) {
                  console.error(`Stripe Webhook: webinarId missing in planSnapshot for webinar OrderItem ${item.id} in Order ${order.id}. Skipping fulfillment for this item.`);
                  continue; // Skip this item if webinarId is crucial and missing
                }

                // Create WebinarRegistration
                const webinarRegistration = await tx.webinarRegistration.create({
                  data: {
                    userId: order.userId,
                    webinarId: webinarId, // Link to the specific Webinar instance
                    webinarPlanId: item.planId, // Link to the WebinarPlan
                    orderId: order.id, // Link to the Order (this establishes the unique constraint)
                    status: "CONFIRMED", // Or a more appropriate status enum/value
                  },
                });

                // Update the Order with the webinarRegistrationId
                // This is for the 1:1 relation from Order -> WebinarRegistration
                await tx.order.update({
                  where: { id: order.id },
                  data: { webinarRegistrationId: webinarRegistration.id },
                });

                console.log(`Stripe Webhook: WebinarRegistration ${webinarRegistration.id} for Order ${order.id}, Item ${item.id} (Webinar ${webinarId}) fulfilled.`);
              } else {
                console.error(`Stripe Webhook: planSnapshot is missing or not an object for webinar OrderItem ${item.id} in Order ${order.id}. Skipping fulfillment for this item.`);
              }
              break;
            }
            case ProductType.SUBSCRIPTION: {
              const _typedPlanSnapshot = planSnapshot as SubscriptionPlanSnapshot;
              // _typedPlanSnapshot is cast for type safety and potential future use if snapshot contains relevant data.

              const subscriptionPlan = await tx.subscriptionPlan.findUnique({
                where: { id: item.planId },
              });

              if (!subscriptionPlan) {
                console.error(`Stripe Webhook: SubscriptionPlan with id ${item.planId} not found for OrderItem ${item.id}. Skipping fulfillment.`);
                continue;
              }

              const consulteeProfile = await tx.consulteeProfile.findUnique({
                where: { userId: order.userId },
                select: { id: true },
              });

              if (!consulteeProfile) {
                console.error(`Stripe Webhook: ConsulteeProfile not found for userId ${order.userId} for Order ${order.id}. Cannot create Subscription.`);
                throw new Error(`ConsulteeProfile not found for userId ${order.userId}, cannot fulfill subscription.`);
              }

              const startDate = new Date();
              const endDate = new Date(startDate);
              endDate.setMonth(startDate.getMonth() + subscriptionPlan.durationInMonths);

              const newSubscription = await tx.subscription.create({
                data: {
                  startDate: startDate,
                  endDate: endDate,
                  requestStatus: RequestStatus.APPROVED,
                  requestedById: consulteeProfile.id,
                  subscriptionPlanId: item.planId,
                  Order: { connect: { id: order.id } }, // Link Subscription to Order
                },
              });

              // Update the Order with the new subscriptionId
              await tx.order.update({
                where: { id: order.id },
                data: { subscriptionId: newSubscription.id }, // Link Order to Subscription
              });

              console.log(`Stripe Webhook: Subscription ${newSubscription.id} for Order ${order.id}, Item ${item.id} fulfilled. Active from ${startDate.toISOString()} to ${endDate.toISOString()}.`);
              break;
            }
            default:
              console.warn(`Stripe Webhook: Unknown product type ${item.productType} for order item ${item.id}`);
          }
        }
      });
    }

    if (event.type === "payment_intent.payment_failed") {
      const paymentIntent = event.data.object;

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const paymentRecord = await tx.payment.findFirst({
          where: { paymentIntent: paymentIntent.id },
        });

        if (paymentRecord) {
          // 1. Update Payment status
          await tx.payment.update({
            where: { id: paymentRecord.id },
            data: { paymentStatus: PaymentStatus.FAILED },
          });

          // 2. Update Order status (if orderId exists on payment)
          if (paymentRecord.orderId) {
            await tx.order.update({
              where: { id: paymentRecord.orderId },
              data: { status: OrderStatus.FAILED },
            });
            // TODO: Handle any necessary rollbacks or notifications for failed payment related to order items
            console.log(`TODO: Handle post-failure logic for order ${paymentRecord.orderId} and its items.`);
          } else {
            console.warn(`Stripe Webhook (Payment Failed): No orderId found on payment record ${paymentRecord.id} for paymentIntent ${paymentIntent.id}`);
          }
        } else {
          console.warn(`Stripe Webhook (Payment Failed): No payment record found for paymentIntent ${paymentIntent.id}`);
        }
      });
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Webhook handler failed", details: errorMessage },
      { status: 400 },
    );
  }
}
