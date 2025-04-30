import nodemailer from 'nodemailer';
import crypto from 'crypto';
import prisma from '@/lib/prisma';
import bcrypt from 'bcrypt';

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_SERVER_HOST,
  port: Number(process.env.EMAIL_SERVER_PORT),
  secure: Number(process.env.EMAIL_SERVER_PORT) === 465, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_SERVER_USER,
    pass: process.env.EMAIL_SERVER_PASSWORD,
  },
});

/**
 * Generates a password reset token, saves it to the user record, and sends the reset email.
 */
export const sendPasswordResetEmail = async (email: string) => {
  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    // Don't reveal if the user exists or not
    console.log(`Password reset attempt for non-existent email: ${email}`);
    return;
  }

  // Generate a secure token
  const resetToken = crypto.randomBytes(32).toString('hex');
  const passwordResetToken = await bcrypt.hash(resetToken, 10); // Hash the token before storing
  const passwordResetExpires = new Date(Date.now() + 3600000); // Token expires in 1 hour

  await prisma.user.update({
    where: { email },
    data: {
      passwordResetToken,
      passwordResetExpires,
    },
  });

  const resetUrl = `${process.env.NEXTAUTH_URL}/auth/reset-password?token=${resetToken}`;

  const mailOptions = {
    from: process.env.EMAIL_FROM,
    to: email,
    subject: 'Reset Your ConsultX Password',
    html: `
        <p>You requested a password reset for your ConsultX account.</p>
        <p>Click the link below to reset your password. This link will expire in 1 hour.</p>
        <a href="${resetUrl}">Reset Password</a>
        <p>If you did not request this, please ignore this email.</p>
      `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Password reset email sent to ${email}`);
  } catch (error) {
    console.error(`Error sending password reset email to ${email}:`, error);
    // Handle email sending errors (e.g., log, notify admin)
    // Optionally, throw an error or return a status to the API route
    throw new Error("Could not send password reset email.");
  }
}; 