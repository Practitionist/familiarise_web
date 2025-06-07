import prisma from "@/lib/prisma";
import { PaymentStatus, OrderStatus, ProductType, Prisma, AppointmentsType, RequestStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import crypto from "crypto";

interface RazorpayPayment {
  order_id: string;
  status: string;
  notes: Record<string, string>;
  receipt_url?: string;
}

// Define Plan Snapshot Interfaces (similar to Stripe webhook)
interface ConsultationPlanSnapshot {
  slotId?: string;
  consultationId?: string;
}

interface WebinarPlanSnapshot {
  webinarId?: string;
}

interface ClassPlanSnapshot {
  classId?: string;
}


interface RazorpayWebhookEvent {
  event: string;
  payload: {
    payment: {
      entity: RazorpayPayment;
    };
    order: {
      entity: {
        id: string;
        notes: Record<string, string>;
      };
    };
  };
}

export async function POST(req: Request) {
  const signature = req.headers.get("x-razorpay-signature");

  if (!signature) {
    return NextResponse.json({ error: "No signature found" }, { status: 400 });
  }

  try {
    const body = await req.text();

    // Verify webhook signature
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET!)
      .update(body)
      .digest("hex");

    if (signature !== expectedSignature) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    const event = JSON.parse(body) as RazorpayWebhookEvent;

    if (event.event === "order.paid") {
      const razorpayOrder = event.payload.order.entity;
      const razorpayPayment = event.payload.payment.entity;

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // 1. Update Payment status
        // Assuming your 'paymentIntent' field in Payment model stores Razorpay's order_id
        const updatedPayment = await tx.payment.updateMany({
          where: { paymentIntent: razorpayOrder.id }, 
          data: {
            paymentStatus: PaymentStatus.SUCCEEDED,
            receiptUrl: razorpayPayment.receipt_url, // Corrected to use razorpayPayment
          },
        });

        if (updatedPayment.count === 0) {
          console.error(`Razorpay Webhook: No payment record found to update for Razorpay order_id ${razorpayOrder.id}`);
          throw new Error(`Payment record not found for Razorpay order_id ${razorpayOrder.id}`);
        }

        // Retrieve the payment record to get your internal orderId
        const paymentRecord = await tx.payment.findFirst({
          where: { paymentIntent: razorpayOrder.id }, 
        });

        if (!paymentRecord?.orderId) {
          console.error(`Razorpay Webhook: Payment record not found or internal orderId missing for Razorpay order_id ${razorpayOrder.id}`);
          throw new Error(`Payment record not found or internal orderId missing after update for Razorpay order_id ${razorpayOrder.id}`);
        }

        // 2. Update internal Order status
        const order = await tx.order.update({
          where: { id: paymentRecord.orderId },
          data: { status: OrderStatus.COMPLETED },
          include: { items: true }, // Include items for fulfillment
        });

        if (!order) {
          console.error(`Razorpay Webhook: Internal order not found for orderId ${paymentRecord.orderId}`);
          throw new Error(`Internal order not found: ${paymentRecord.orderId}`);
        }

        // 3. Process OrderItems for fulfillment
        for (const item of order.items) {
          switch (item.productType) {
            case ProductType.CONSULTATION: {
              const planSnapshot = item.planSnapshot;
              if (planSnapshot && typeof planSnapshot === 'object') {
                const typedPlanSnapshot = planSnapshot as ConsultationPlanSnapshot;
                const slotId = typedPlanSnapshot.slotId;
                let consultationId = typedPlanSnapshot.consultationId;

                if (!slotId) {
                  console.error(`Razorpay Webhook: slotId missing in planSnapshot for consultation OrderItem ${item.id} in Order ${order.id}. Skipping fulfillment.`);
                  continue;
                }

                const appointment = await tx.appointment.create({
                  data: { appointmentType: AppointmentsType.CONSULTATION },
                });
                const appointmentId = appointment.id;

                await tx.slotOfAppointment.update({
                  where: { id: slotId },
                  data: {
                    appointmentId: appointmentId
                  },
                });

                if (consultationId) {
                  await tx.consultation.update({
                    where: { id: consultationId },
                    data: {
                      appointment: { connect: { id: appointmentId } },
                      requestStatus: RequestStatus.APPROVED,
                      Order: { connect: { id: order.id } },
                    },
                  });
                } else {
                  const newConsultation = await tx.consultation.create({
                    data: {
                      consultationPlanId: item.planId,
                      requestedById: order.userId, // Assuming consulteeProfile.id can be derived or is same as userId
                      appointment: { connect: { id: appointmentId } },
                      requestStatus: RequestStatus.APPROVED,
                      directlyBooked: true,
                      Order: { connect: { id: order.id } },
                    },
                  });
                  consultationId = newConsultation.id;
                }

                await tx.appointment.update({
                    where: { id: appointmentId },
                    data: { consultationId: consultationId },
                });
                console.log(`Razorpay Webhook: Consultation OrderItem ${item.id} (Consultation ${consultationId}, Appointment ${appointmentId}) for Order ${order.id} fulfilled.`);
              } else {
                console.error(`Razorpay Webhook: planSnapshot missing for consultation OrderItem ${item.id} in Order ${order.id}. Skipping.`);
              }
              break;
            }
            case ProductType.CLASS: {
              const planSnapshot = item.planSnapshot;
              if (planSnapshot && typeof planSnapshot === 'object') {
                const typedPlanSnapshot = planSnapshot as ClassPlanSnapshot;
                const classId = typedPlanSnapshot.classId;

                if (!classId) {
                  console.error(`Razorpay Webhook: classId missing in planSnapshot for class OrderItem ${item.id} in Order ${order.id}. Skipping fulfillment.`);
                  continue;
                }

                const classRegistration = await tx.classRegistration.create({
                  data: {
                    userId: order.userId,
                    classId: classId,
                    classPlanId: item.planId,
                    orderId: order.id,
                    status: "CONFIRMED",
                  },
                });

                await tx.order.update({
                  where: { id: order.id },
                  data: { classRegistrationId: classRegistration.id },
                });

                console.log(`Razorpay Webhook: ClassRegistration ${classRegistration.id} for Order ${order.id}, Item ${item.id} (Class ${classId}) fulfilled.`);
              } else {
                console.error(`Razorpay Webhook: planSnapshot missing for class OrderItem ${item.id} in Order ${order.id}. Skipping.`);
              }
              break;
            }
            case ProductType.WEBINAR: {
              const planSnapshot = item.planSnapshot;
              if (planSnapshot && typeof planSnapshot === 'object') {
                const typedPlanSnapshot = planSnapshot as WebinarPlanSnapshot;
                const webinarId = typedPlanSnapshot.webinarId;

                if (!webinarId) {
                  console.error(`Razorpay Webhook: webinarId missing in planSnapshot for webinar OrderItem ${item.id} in Order ${order.id}. Skipping fulfillment.`);
                  continue;
                }

                const webinarRegistration = await tx.webinarRegistration.create({
                  data: {
                    userId: order.userId,
                    webinarId: webinarId,
                    webinarPlanId: item.planId,
                    orderId: order.id,
                    status: "CONFIRMED",
                  },
                });

                await tx.order.update({
                  where: { id: order.id },
                  data: { webinarRegistrationId: webinarRegistration.id },
                });

                console.log(`Razorpay Webhook: WebinarRegistration ${webinarRegistration.id} for Order ${order.id}, Item ${item.id} (Webinar ${webinarId}) fulfilled.`);
              } else {
                console.error(`Razorpay Webhook: planSnapshot missing for webinar OrderItem ${item.id} in Order ${order.id}. Skipping.`);
              }
              break;
            }
            case ProductType.SUBSCRIPTION: {
              const subscriptionPlan = await tx.subscriptionPlan.findUnique({
                where: { id: item.planId },
              });

              if (!subscriptionPlan) {
                console.error(`Razorpay Webhook: SubscriptionPlan not found for ID ${item.planId} in OrderItem ${item.id}, Order ${order.id}. Skipping fulfillment.`);
                continue;
              }

              const startDate = new Date();
              const endDate = new Date(startDate);
              endDate.setMonth(startDate.getMonth() + subscriptionPlan.durationInMonths);

              // Ensure consulteeProfile exists for the user
              const consulteeProfile = await tx.consulteeProfile.findUnique({
                where: { userId: order.userId },
              });

              if (!consulteeProfile) {
                // Potentially create one if it's guaranteed a user always has/needs one upon subscription
                // For now, we'll log an error if not found, as per Stripe webhook's implicit assumption
                console.error(`Razorpay Webhook: ConsulteeProfile not found for userId ${order.userId} when creating subscription for Order ${order.id}. Skipping.`);
                // Or, create if business logic dictates:
                // consulteeProfile = await tx.consulteeProfile.create({
                //   data: { userId: order.userId, /* other required fields */ }
                // });
                // console.log(`Razorpay Webhook: Created ConsulteeProfile ${consulteeProfile.id} for User ${order.userId}`);
                continue; // If profile is strictly required and not found/created
              }

              const subscription = await tx.subscription.create({
                data: {
                  requestedById: consulteeProfile.id, // Correct: Link to ConsulteeProfile via requestedById
                  subscriptionPlanId: item.planId,
                  Order: { connect: { id: order.id } }, // Correct: Relate to Order model
                  startDate: startDate,
                  endDate: endDate,
                  requestStatus: RequestStatus.APPROVED, // Correct: Use RequestStatus enum
                },
              });

              await tx.order.update({
                where: { id: order.id },
                data: { subscriptionId: subscription.id },
              });

              console.log(`Razorpay Webhook: Subscription ${subscription.id} for Order ${order.id}, Item ${item.id} (Plan ${item.planId}) fulfilled. Ends on ${endDate.toISOString()}`);
              break;
            }
            default:
              console.warn(`Razorpay Webhook: Unknown product type ${item.productType} for order item ${item.id}`);
          }
        }
      });
    }

    if (event.event === "payment.failed" || event.event === "order.payment.failed") { // Handling both common event names for failure
      const razorpayOrderEntity = event.payload.order?.entity; // Order entity might not be present in 'payment.failed'
      const razorpayPaymentEntity = event.payload.payment?.entity;
      
      // Determine the paymentIntent (Razorpay order_id) from available payload
      const razorpayOrderId = razorpayPaymentEntity?.order_id || razorpayOrderEntity?.id;

      if (!razorpayOrderId) {
        console.error("Razorpay Webhook (Failed): Could not determine Razorpay Order ID from webhook payload.", event.payload);
        throw new Error("Missing Razorpay Order ID in failure webhook.");
      }

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const paymentRecord = await tx.payment.findFirst({
          where: { paymentIntent: razorpayOrderId }, 
        });

        if (paymentRecord) {
          // 1. Update Payment status
          await tx.payment.update({
            where: { id: paymentRecord.id },
            data: { paymentStatus: PaymentStatus.FAILED },
          });

          // 2. Update internal Order status (if orderId exists on payment)
          if (paymentRecord.orderId) {
            await tx.order.update({
              where: { id: paymentRecord.orderId },
              data: { status: OrderStatus.FAILED },
            });
            // TODO: Handle any necessary rollbacks or notifications for failed payment related to order items.
            console.log(`TODO: Handle post-failure logic for order ${paymentRecord.orderId} and its items.`);
          } else {
            console.warn(`Razorpay Webhook (Payment Failed): No internal orderId found on payment record ${paymentRecord.id} for Razorpay order_id ${razorpayOrderId}`);
          }
        } else {
          console.warn(`Razorpay Webhook (Payment Failed): No payment record found for Razorpay order_id ${razorpayOrderId}`);
        }
      });
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Razorpay webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 400 },
    );
  }
}
