# Razorpay KYC Overview

## Purpose

This document provides an overview of the Razorpay KYC (Know Your Customer) process required to activate a live payment gateway account.

## Table of Contents

1. [Test vs Live Mode](#test-vs-live-mode)
2. [KYC Requirement](#kyc-requirement)
3. [Timeline](#timeline)
4. [Document Requirements](#document-requirements)
5. [Submission Process](#submission-process)
6. [Live API Keys](#live-api-keys)
7. [Related Documentation](#related-documentation)

---

## Test vs Live Mode

### Test Mode

- **Available immediately** upon Razorpay account signup
- No KYC required
- Use test API keys (starts with `rzp_test_`)
- Accept test payments using test card numbers
- Cannot process real transactions
- Ideal for development and testing

### Live Mode

- **Requires completed KYC** and business verification
- Use live API keys (starts with `rzp_live_`)
- Process real customer payments
- Subject to Razorpay's transaction fees
- Full production capabilities

**Current Status**: Our application is using **Test Mode** for development.

---

## KYC Requirement

To activate live mode, Razorpay requires:

1. **Business Verification**: Proof of legal business entity
2. **Bank Account Verification**: Valid business bank account details
3. **Identity Verification**: Authorized signatory identification
4. **Compliance Documents**: Based on business type and industry

### Why KYC is Required

- **Regulatory Compliance**: RBI (Reserve Bank of India) mandates for payment processors
- **Fraud Prevention**: Verify legitimate business operations
- **Risk Management**: Assess merchant risk profile
- **Settlement Security**: Ensure funds reach verified accounts

---

## Timeline

### Typical KYC Approval Timeline

| Stage                   | Duration          | Details                                        |
| ----------------------- | ----------------- | ---------------------------------------------- |
| **Document Submission** | 30-60 minutes     | Initial document upload via Razorpay Dashboard |
| **Initial Review**      | 24-48 hours       | Razorpay reviews submitted documents           |
| **Verification**        | 1-2 business days | Background checks and document validation      |
| **Approval/Rejection**  | 2-4 business days | Final decision communicated via email          |

**Total Expected Time**: 2-4 business days (if all documents are correct)

### Factors Affecting Timeline

**Delays can occur due to:**

- Incomplete or unclear document uploads
- Mismatch between submitted documents and business details
- Additional verification requirements for specific industries
- High volume of applications during festive seasons
- Documents not meeting format/size requirements

**Faster Approval Tips:**

- Upload clear, high-resolution documents
- Ensure all information matches across documents
- Double-check business details in Razorpay Dashboard
- Respond promptly to any clarification requests
- Have all documents ready before starting the process

---

## Document Requirements

### General Requirements (All Business Types)

All businesses must provide:

1. **Business Documentation**
   - Proof of business entity (varies by business type)
   - Business PAN Card (if applicable)

2. **Bank Account Verification**
   - Cancelled cheque with bank details visible OR
   - Bank statement/letterhead with account details

3. **Authorized Signatory Details**
   - Government-issued ID proof (Aadhar/Voter ID/Passport/Driving License)
   - PAN Card of the authorized signatory

### Format Requirements

- **File Types**: PDF, JPG, JPEG, PNG
- **File Size**: Maximum 5MB per document
- **Image Quality**: Clear and readable text
- **Document Validity**: Current/unexpired documents
- **Stamp/Seal**: Visible on official documents where applicable

### Special Requirements

Some business types and industries require additional documents:

- Registration certificates (for registered entities)
- Industry-specific licenses (FSSAI, SEBI, NBFC, etc.)
- Additional compliance certificates

> For detailed requirements by business type, see [BUSINESS_TYPES_REQUIREMENTS.md](./BUSINESS_TYPES_REQUIREMENTS.md)

> For industry-specific certifications, see [INDUSTRY_CERTIFICATIONS.md](./INDUSTRY_CERTIFICATIONS.md)

---

## Submission Process

### Step-by-Step Process

#### 1. Access Razorpay Dashboard

- Log in to [Razorpay Dashboard](https://dashboard.razorpay.com/)
- Navigate to **Settings** → **Account & Settings**

#### 2. Complete Business Details

Fill in accurate information:

- Legal business name (as per registration documents)
- Business type (LLP, Private Limited, Sole Proprietorship, etc.)
- Business address
- Industry/business category
- Website URL
- Contact details

#### 3. Upload Documents

- Navigate to **Documents** section
- Upload all required documents based on your business type
- Ensure document format and size compliance
- Verify all uploads are clear and readable

#### 4. Bank Account Details

- Add bank account information
- Upload cancelled cheque or bank statement
- Verify account holder name matches business name

#### 5. Authorized Signatory

- Add authorized signatory details
- Upload ID proof and PAN card
- Verify signatory has authority to operate business

#### 6. Submit for Review

- Review all entered information
- Click **Submit for Verification**
- Wait for email confirmation

#### 7. Track Status

- Check verification status in Dashboard
- Monitor email for any clarification requests
- Respond promptly if additional documents are needed

### Post-Submission

After submission, Razorpay will:

1. Send confirmation email
2. Review submitted documents
3. Conduct background verification
4. Request additional information if needed
5. Send approval/rejection email

**If Approved:**

- Live API keys become available
- Enable live mode in Dashboard
- Start accepting real payments

**If Rejected:**

- Email will specify reason for rejection
- Resubmit corrected documents
- Restart verification process

---

## Live API Keys

### Accessing Live API Keys

Once KYC is approved:

1. Navigate to Razorpay Dashboard
2. Go to **Settings** → **API Keys**
3. Click **Generate Live Keys**
4. Copy **Key ID** and **Key Secret**

### Security Best Practices

**CRITICAL**: Live API keys must be kept secure!

- **Never commit to version control** (Git, GitHub, GitLab)
- **Use environment variables** (`.env.local` file)
- **Restrict access** to authorized team members only
- **Rotate keys regularly** for security
- **Use different keys** for staging and production
- **Monitor API usage** in Dashboard for suspicious activity

### Implementation in Our Application

Update environment variables:

```bash
# .env.local
RAZORPAY_KEY_ID=rzp_live_XXXXXXXXXXXX
RAZORPAY_KEY_SECRET=YYYYYYYYYYYYYYYY
```

Update application configuration:

- Switch from test mode to live mode
- Update webhook endpoints
- Test in staging environment first
- Deploy to production

---

## Related Documentation

### Internal Documentation

- [BUSINESS_TYPES_REQUIREMENTS.md](./BUSINESS_TYPES_REQUIREMENTS.md) - Detailed requirements for all 12 business types
- [INDUSTRY_CERTIFICATIONS.md](./INDUSTRY_CERTIFICATIONS.md) - Industry-specific certificate requirements
- [SETUP_CHECKLIST.md](./SETUP_CHECKLIST.md) - Step-by-step setup checklist

### External Resources

- [Razorpay KYC Documentation](https://razorpay.com/docs/payments/business-types-kyc-documents/)
- [Razorpay Dashboard](https://dashboard.razorpay.com/)
- [Razorpay Support](https://razorpay.com/support/)

---

## Common Questions

### Can I use live mode without KYC?

**No.** KYC approval is mandatory for live mode and processing real payments.

### How long does KYC approval take?

**Typically 2-4 business days** if all documents are correct and complete.

### What if my KYC is rejected?

You'll receive an email with rejection reason. Correct the issues and resubmit documents.

### Can I test payments before KYC approval?

**Yes.** Test mode is available immediately for development and testing.

### Do I need to renew KYC?

Generally no, but Razorpay may request updated documents for compliance or if business details change significantly.

### What happens to test data after going live?

Test mode data is separate from live mode. Test transactions, customers, and orders won't affect live data.

### Can I switch between test and live mode?

**Yes.** You can toggle between test and live mode in the Dashboard, but ensure you're using the correct API keys in your application.

---

## Next Steps

1. Review [BUSINESS_TYPES_REQUIREMENTS.md](./BUSINESS_TYPES_REQUIREMENTS.md) to identify your business type
2. Gather all required documents
3. Check [INDUSTRY_CERTIFICATIONS.md](./INDUSTRY_CERTIFICATIONS.md) for any additional licenses needed
4. Use [SETUP_CHECKLIST.md](./SETUP_CHECKLIST.md) to track your progress
5. Submit KYC application through Razorpay Dashboard
6. Wait for approval (2-4 business days)
7. Generate live API keys
8. Update application configuration
9. Test in staging environment
10. Deploy to production

---

**Last Updated**: 2025-11-06
**Status**: Pending KYC Submission
