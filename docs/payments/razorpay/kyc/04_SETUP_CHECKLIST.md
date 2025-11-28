# Razorpay Live Account Setup Checklist

## Purpose

This checklist provides a step-by-step guide to complete Razorpay KYC and activate live payment gateway for production use.

## Table of Contents

1. [Pre-Setup Requirements](#pre-setup-requirements)
2. [Phase 1: Account Creation](#phase-1-account-creation)
3. [Phase 2: Document Preparation](#phase-2-document-preparation)
4. [Phase 3: KYC Submission](#phase-3-kyc-submission)
5. [Phase 4: Post-Approval Setup](#phase-4-post-approval-setup)
6. [Phase 5: Integration & Testing](#phase-5-integration--testing)
7. [Phase 6: Go Live](#phase-6-go-live)
8. [Troubleshooting](#troubleshooting)

---

## Pre-Setup Requirements

Before starting the KYC process, ensure you have:

### Business Requirements

- [ ] **Legal Business Entity Registered**
  - Company/LLP/Partnership registered with appropriate authority
  - Registration certificate available
  - Registration is active and not suspended

- [ ] **PAN Card Obtained**
  - Company/Business PAN card (if applicable)
  - Individual PAN for authorized signatory
  - PAN cards are active and not cancelled

- [ ] **Bank Account Opened**
  - Business bank account (current account preferred)
  - Account in business name (or individual name for Sole Proprietorship)
  - Cancelled cheque or bank statement available

- [ ] **Authorized Signatory Identified**
  - Director/Partner/Proprietor identified
  - Has authority to operate business
  - Government-issued ID proof available

### Industry-Specific Requirements

- [ ] **Identify if Your Industry Needs Additional Licenses**
  - Review [INDUSTRY_CERTIFICATIONS.md](./INDUSTRY_CERTIFICATIONS.md)
  - Obtain required industry licenses (FSSAI, RBI, SEBI, etc.)
  - Ensure licenses are active and valid

### Technical Requirements

- [ ] **Website/App Ready**
  - Domain name registered
  - Website/app is live and functional
  - Terms & Conditions, Privacy Policy, Refund Policy pages created

- [ ] **Development Environment Set Up**
  - Test mode API keys obtained
  - Payment integration tested in development
  - Test transactions successful

### Decision Points

- [ ] **Determine Business Type**
  - Review [BUSINESS_TYPES_REQUIREMENTS.md](./BUSINESS_TYPES_REQUIREMENTS.md)
  - Select business type matching your registration
  - Identify documents needed for your business type

---

## Phase 1: Account Creation

### Step 1.1: Sign Up for Razorpay Account

- [ ] Visit [razorpay.com](https://razorpay.com)
- [ ] Click "Sign Up" or "Get Started"
- [ ] Provide required information:
  - [ ] Business email (use official domain email, not Gmail/Yahoo)
  - [ ] Mobile number
  - [ ] Create strong password
- [ ] Verify email address (check inbox for verification link)
- [ ] Verify mobile number (enter OTP)

**Status**: ⏳ Pending / ✅ Completed

---

### Step 1.2: Access Razorpay Dashboard

- [ ] Log in to [dashboard.razorpay.com](https://dashboard.razorpay.com)
- [ ] Complete initial setup wizard (if prompted)
- [ ] Familiarize yourself with dashboard navigation

**Status**: ⏳ Pending / ✅ Completed

---

### Step 1.3: Get Test API Keys

- [ ] Navigate to **Settings** → **API Keys** in dashboard
- [ ] View/Generate **Test Keys** (starts with `rzp_test_`)
- [ ] Copy **Key ID** and **Key Secret**
- [ ] Store keys securely (use environment variables)
- [ ] **NEVER commit test keys to Git repository**

**Test Keys Obtained**:

- Key ID: `rzp_test_________________`
- Key Secret: `________________________` (stored in `.env.local`)

**Status**: ⏳ Pending / ✅ Completed

---

## Phase 2: Document Preparation

### Step 2.1: Gather Standard KYC Documents

Based on your business type, gather the following documents:

#### For All Business Types (except Individual/Unregistered):

- [ ] **Business Registration Certificate**
  - Certificate of Incorporation / LLP Certificate / Partnership Deed
  - Format: PDF/JPG/PNG, Max 5MB
  - Clear and readable

- [ ] **Company PAN Card**
  - PAN in business name
  - Format: PDF/JPG/PNG, Max 5MB
  - Active PAN

- [ ] **Bank Account Proof**
  - [ ] Option 1: Cancelled cheque (with pre-printed details visible)
  - [ ] Option 2: Bank statement (latest 3 months)
  - Format: JPG/PNG/PDF, Max 5MB
  - Account in business name

- [ ] **Authorized Signatory ID Proof** (any one):
  - [ ] Aadhar Card (front & back)
  - [ ] Voter ID
  - [ ] Passport (photo page)
  - [ ] Driving License (front & back)
  - Format: PDF/JPG/PNG, Max 5MB
  - Government-issued, current/unexpired

- [ ] **Authorized Signatory PAN Card**
  - Individual PAN of signatory
  - Format: PDF/JPG/PNG, Max 5MB
  - Active PAN

#### For Sole Proprietorship (Additional):

- [ ] **MSME Certificate** OR **GST Certificate**
  - Format: PDF/JPG/PNG, Max 5MB
  - Active registration

- [ ] **Address Proof**
  - Utility bill / Rent agreement / Aadhar
  - Format: PDF/JPG/PNG, Max 5MB

#### For Individual/Unregistered:

- [ ] **Individual ID Proof**
- [ ] **Individual PAN Card**
- [ ] **Cancelled Cheque** (personal account)

**Status**: ⏳ Pending / ✅ Completed

---

### Step 2.2: Obtain Industry-Specific Certifications

If your business operates in a regulated industry, obtain required licenses:

#### Healthcare:

- [ ] Drug License / Pharmacy License (if applicable)
- [ ] NABH/NABL Certification (if applicable)
- [ ] Medical Council Registration (if applicable)

#### Financial Services:

- [ ] RBI NBFC Certificate (if applicable)
- [ ] SEBI Registration (if applicable)
- [ ] IRDAI License (if applicable)
- [ ] AMFI Registration (if applicable)

#### Food & Beverage:

- [ ] FSSAI License (mandatory for all food businesses)
  - Type: Basic / State / Central
  - 14-digit license number
- [ ] State Excise License (if selling alcohol)

#### Travel:

- [ ] IATA License (if applicable)
- [ ] State Tourism License (if applicable)
- [ ] Hotel License (if applicable)

#### Education:

- [ ] University/Board Affiliation (if applicable)
- [ ] Ministry of Education Approval (if applicable)

#### Real Estate:

- [ ] RERA Registration (mandatory)
  - Project Registration (for developers)
  - Agent Registration (for brokers)

#### Professional Services:

- [ ] ICAI Certificate of Practice (CA)
- [ ] Bar Council Enrollment (Lawyer)
- [ ] Medical Council Registration (Doctor)
- [ ] Council of Architecture Certificate (Architect)

#### Other:

- [ ] Industry-specific license (refer to [INDUSTRY_CERTIFICATIONS.md](./INDUSTRY_CERTIFICATIONS.md))

**Status**: ⏳ Pending / ✅ Completed / ❌ Not Applicable

---

### Step 2.3: Prepare Digital Copies

- [ ] Scan/photograph all documents
- [ ] Ensure high resolution (minimum 300 DPI)
- [ ] Good lighting, no shadows
- [ ] All text clearly readable
- [ ] Complete document visible (no cropped edges)
- [ ] Convert to acceptable formats (PDF/JPG/PNG)
- [ ] Compress if needed (keep under 5MB per file)
- [ ] Name files appropriately (e.g., "Company_PAN.pdf")

**Quality Checklist**:

- [ ] All documents clear and readable
- [ ] No blurry or pixelated images
- [ ] Correct orientation (not upside down)
- [ ] File size under 5MB each
- [ ] Proper format (PDF/JPG/PNG)

**Status**: ⏳ Pending / ✅ Completed

---

### Step 2.4: Verify Document Accuracy

Before uploading, double-check:

- [ ] **Name Consistency**
  - Business name matches across all documents
  - No variations (e.g., "Pvt Ltd" vs "Private Limited")

- [ ] **PAN Matching**
  - Company PAN matches business name
  - Signatory PAN matches ID proof

- [ ] **Bank Account**
  - Account holder name matches business name
  - Cancelled cheque is legible
  - Account type is appropriate (current account for companies)

- [ ] **Signatory Authorization**
  - Signatory is a director/partner/proprietor
  - Has legal authority to operate business

- [ ] **Document Validity**
  - No expired documents
  - Registrations are active
  - Licenses are current

**Status**: ⏳ Pending / ✅ Completed

---

## Phase 3: KYC Submission

### Step 3.1: Complete Business Profile

- [ ] Log in to [Razorpay Dashboard](https://dashboard.razorpay.com)
- [ ] Navigate to **Settings** → **Account & Settings**
- [ ] Click **Complete Your KYC** or **Activate Account**

**Fill Business Details**:

- [ ] **Legal Business Name**
  - Enter exact name as per registration documents
  - Double-check spelling and format

- [ ] **Business Type**
  - Select from: Private Limited, LLP, Partnership, Sole Proprietorship, etc.
  - Match your actual registration
  - Review [BUSINESS_TYPES_REQUIREMENTS.md](./BUSINESS_TYPES_REQUIREMENTS.md) if unsure

- [ ] **Business Category**
  - Select primary business category
  - Select sub-category
  - Be specific and accurate

- [ ] **Business Address**
  - Registered office address
  - State and PIN code
  - Should match registration documents

- [ ] **Website URL**
  - Enter your website/app URL
  - Ensure website is live and functional
  - Must have Privacy Policy, Terms, Refund Policy

- [ ] **Business Description**
  - Brief description of your business (2-3 sentences)
  - What products/services you offer
  - Your target customers

- [ ] **Contact Details**
  - Business phone number
  - Business email
  - Support email (if different)

**Status**: ⏳ Pending / ✅ Completed

---

### Step 3.2: Upload Documents

Navigate to **Documents** section in Razorpay Dashboard:

#### Standard Documents:

- [ ] **Business Registration Certificate**
  - Select document type
  - Upload clear copy
  - Verify upload successful

- [ ] **Company PAN Card**
  - Enter PAN number
  - Upload PAN card image
  - Verify PAN number matches card

- [ ] **Bank Account Details**
  - Enter account number
  - Enter IFSC code
  - Upload cancelled cheque or bank statement
  - Verify account holder name matches

- [ ] **Authorized Signatory Details**
  - Enter signatory name
  - Enter signatory email
  - Enter signatory mobile
  - Upload ID proof
  - Upload PAN card

#### Industry-Specific Documents (if applicable):

- [ ] **FSSAI License** (food business)
  - Enter 14-digit license number
  - Upload license certificate

- [ ] **RERA Registration** (real estate)
  - Enter RERA number
  - Upload registration certificate

- [ ] **Professional License** (CA/Doctor/Lawyer/Architect)
  - Enter registration/enrollment number
  - Upload certificate

- [ ] **Other Industry Licenses**
  - Upload as per requirements
  - Ensure all regulated activities are covered

**Upload Checklist**:

- [ ] All required documents uploaded
- [ ] Document types correctly selected
- [ ] File sizes within limits
- [ ] All uploads successful (green checkmark)
- [ ] No errors or warnings

**Status**: ⏳ Pending / ✅ Completed

---

### Step 3.3: Review and Submit

- [ ] Review all entered information
- [ ] Double-check for typos or errors
- [ ] Verify all documents uploaded
- [ ] Ensure all mandatory fields completed
- [ ] Click **Review** to see summary
- [ ] Make corrections if needed
- [ ] Click **Submit for Verification**
- [ ] Note submission date and time
- [ ] Take screenshot of submission confirmation

**Submission Details**:

- Submission Date: ******\_\_\_******
- Submission Time: ******\_\_\_******
- Application Reference Number: ******\_\_\_******

**Status**: ⏳ Pending / ✅ Completed

---

### Step 3.4: Confirmation

- [ ] Receive confirmation email from Razorpay
- [ ] Check email for application receipt
- [ ] Save confirmation email for reference
- [ ] Note expected response time (2-4 business days)

**Confirmation Email Received**: ⏳ Pending / ✅ Completed

---

## Phase 4: Post-Approval Setup

### Step 4.1: Monitor Application Status

While waiting for approval (2-4 business days):

- [ ] Check Razorpay Dashboard daily for status updates
- [ ] Monitor email for any clarification requests
- [ ] Keep phone accessible for verification calls
- [ ] Respond promptly to any Razorpay queries

**Check for Status**:

- [ ] Day 1: Application submitted
- [ ] Day 2: Under review
- [ ] Day 3: Verification in progress
- [ ] Day 4: Approved / Pending clarification

**Current Status**: ********\_********

---

### Step 4.2: Handle Clarifications (if any)

If Razorpay requests additional information:

- [ ] Read clarification email carefully
- [ ] Understand what is being requested
- [ ] Gather requested documents/information
- [ ] Respond within 24-48 hours
- [ ] Upload additional documents if needed
- [ ] Confirm submission

**Clarifications Required**: ⏳ Pending / ✅ Completed / ❌ Not Applicable

---

### Step 4.3: Receive Approval Notification

Once approved:

- [ ] Receive approval email from Razorpay
- [ ] Check dashboard for "Activated" status
- [ ] Live mode now available
- [ ] Save approval email for records

**KYC Approval Date**: ******\_\_\_******

**Status**: ⏳ Pending / ✅ Completed

---

### Step 4.4: Generate Live API Keys

After KYC approval:

- [ ] Log in to [Razorpay Dashboard](https://dashboard.razorpay.com)
- [ ] Navigate to **Settings** → **API Keys**
- [ ] Click **Generate Live Keys**
- [ ] Confirm key generation
- [ ] Copy **Live Key ID** (starts with `rzp_live_`)
- [ ] Copy **Live Key Secret**
- [ ] Store keys **securely**
  - Use environment variables
  - Never commit to Git
  - Restrict access to authorized team members only

**Live API Keys Generated**:

- Key ID: `rzp_live_________________`
- Key Secret: Stored securely in password manager

**Security Checklist**:

- [ ] Keys stored in `.env.local` (not `.env`)
- [ ] `.env.local` added to `.gitignore`
- [ ] Keys not shared via email/chat
- [ ] Keys accessible only to authorized team
- [ ] Keys not hardcoded in application

**Status**: ⏳ Pending / ✅ Completed

---

### Step 4.5: Configure Webhook

Set up webhook to receive payment notifications:

- [ ] Navigate to **Settings** → **Webhooks** in dashboard
- [ ] Click **Add Webhook**
- [ ] Enter webhook URL: `https://yourdomain.com/api/webhooks/razorpay`
- [ ] Select events to listen:
  - [ ] `payment.authorized`
  - [ ] `payment.captured`
  - [ ] `payment.failed`
  - [ ] `refund.created`
  - [ ] `refund.processed`
  - [ ] `order.paid`
  - [ ] `dispute.created`
- [ ] Set webhook secret (generate strong secret)
- [ ] Store webhook secret securely
- [ ] Click **Save**

**Webhook Configuration**:

- Webhook URL: ******\_\_\_******
- Webhook Secret: Stored securely

**Status**: ⏳ Pending / ✅ Completed

---

### Step 4.6: Configure Settlement

Set up automatic settlements to your bank account:

- [ ] Navigate to **Settings** → **Settlements**
- [ ] Verify bank account details
- [ ] Set settlement schedule:
  - [ ] Daily (recommended for most businesses)
  - [ ] Weekly
  - [ ] Monthly
- [ ] Enable instant settlements (if required)
- [ ] Review settlement fees
- [ ] Save configuration

**Settlement Configuration**:

- Schedule: ******\_\_\_******
- Settlement Account: ******\_\_\_******

**Status**: ⏳ Pending / ✅ Completed

---

## Phase 5: Integration & Testing

### Step 5.1: Update Application Configuration

Update environment variables in your application:

**File**: `.env.local`

```bash
# Razorpay Configuration
RAZORPAY_KEY_ID=rzp_live_XXXXXXXXXXXX
RAZORPAY_KEY_SECRET=YYYYYYYYYYYYYYYY
RAZORPAY_WEBHOOK_SECRET=webhook_secret_here

# Mode
RAZORPAY_MODE=live
```

**Configuration Checklist**:

- [ ] Live API keys added to `.env.local`
- [ ] `.env.local` not committed to Git
- [ ] Webhook secret configured
- [ ] Mode set to "live"
- [ ] Old test keys removed or commented out
- [ ] Environment variables loaded correctly

**Status**: ⏳ Pending / ✅ Completed

---

### Step 5.2: Update Application Code

Update payment integration code:

- [ ] **Verify API Key Loading**
  - Check keys are loaded from environment variables
  - No hardcoded keys in code

- [ ] **Update Razorpay Instance**

  ```typescript
  const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID!,
    key_secret: process.env.RAZORPAY_KEY_SECRET!,
  });
  ```

- [ ] **Update Frontend Key**

  ```typescript
  // In checkout component
  const options = {
    key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
    // ...other options
  };
  ```

- [ ] **Verify Webhook Signature Validation**

  ```typescript
  const isValid = validateWebhookSignature(
    body,
    signature,
    process.env.RAZORPAY_WEBHOOK_SECRET!
  );
  ```

- [ ] **Error Handling for Live Mode**
  - Add proper error messages
  - Log errors for monitoring
  - User-friendly error display

**Code Review Checklist**:

- [ ] All API calls use environment variables
- [ ] No test keys in code
- [ ] Webhook signature validation implemented
- [ ] Error handling comprehensive
- [ ] Logging configured for production

**Status**: ⏳ Pending / ✅ Completed

---

### Step 5.3: Deploy to Staging Environment

Before going live, test in staging:

- [ ] Deploy code to staging environment
- [ ] Configure staging environment variables
- [ ] Use live API keys in staging
- [ ] Verify application loads correctly
- [ ] Check no errors in console

**Staging Deployment**:

- Staging URL: ******\_\_\_******
- Deployment Date: ******\_\_\_******

**Status**: ⏳ Pending / ✅ Completed

---

### Step 5.4: Test Payment Flow in Staging

Perform end-to-end testing in staging with **real money** (use small amounts):

#### Test Case 1: Successful Payment

- [ ] Navigate to checkout page
- [ ] Select a product/service (use minimum amount)
- [ ] Proceed to payment
- [ ] Enter real card/UPI details
- [ ] Complete payment (**real transaction**)
- [ ] Verify payment success page displayed
- [ ] Check confirmation email sent
- [ ] Verify order created in database
- [ ] Check webhook received and processed
- [ ] Verify payment status updated in dashboard
- [ ] Check Razorpay Dashboard for transaction

**Test Amount**: ₹******\_\_\_******
**Test Result**: ⏳ Pending / ✅ Pass / ❌ Fail

#### Test Case 2: Failed Payment

- [ ] Initiate checkout with small amount
- [ ] Use insufficient balance card OR cancel payment
- [ ] Verify failure handled gracefully
- [ ] Check error message displayed to user
- [ ] Verify failed webhook received
- [ ] Check payment marked as failed in database
- [ ] Verify no order created

**Test Result**: ⏳ Pending / ✅ Pass / ❌ Fail

#### Test Case 3: Refund

- [ ] Process successful test payment
- [ ] Initiate refund from admin dashboard
- [ ] Verify refund API works
- [ ] Check refund webhook received
- [ ] Verify refund status updated in database
- [ ] Verify refund reflected in Razorpay Dashboard
- [ ] Check refund processed to customer (2-7 days)

**Test Result**: ⏳ Pending / ✅ Pass / ❌ Fail

#### Test Case 4: Multiple Payment Methods

Test different payment methods:

- [ ] **Credit Card** - Visa/Mastercard/Amex
- [ ] **Debit Card** - Visa/Mastercard/RuPay
- [ ] **UPI** - UPI ID / QR Code
- [ ] **Net Banking** - Major banks
- [ ] **Wallets** - Paytm, PhonePe, etc.

**Test Results**:

- Credit Card: ⏳ Pending / ✅ Pass / ❌ Fail
- Debit Card: ⏳ Pending / ✅ Pass / ❌ Fail
- UPI: ⏳ Pending / ✅ Pass / ❌ Fail
- Net Banking: ⏳ Pending / ✅ Pass / ❌ Fail
- Wallets: ⏳ Pending / ✅ Pass / ❌ Fail

**Overall Testing Status**: ⏳ Pending / ✅ All Tests Pass / ❌ Some Tests Fail

---

### Step 5.5: Security Audit

Before going live, perform security checks:

- [ ] **API Keys Security**
  - [ ] No keys committed to Git repository
  - [ ] Keys stored in environment variables only
  - [ ] `.env.local` in `.gitignore`
  - [ ] Keys not exposed to client-side code

- [ ] **Webhook Security**
  - [ ] Signature verification implemented
  - [ ] Webhook endpoint protected
  - [ ] HTTPS enforced on webhook URL
  - [ ] Idempotency implemented

- [ ] **Payment Flow Security**
  - [ ] Order amount validated server-side
  - [ ] User authentication required
  - [ ] CSRF protection enabled
  - [ ] SQL injection protection in place

- [ ] **Data Security**
  - [ ] Sensitive data encrypted
  - [ ] Database properly secured
  - [ ] No payment card details stored
  - [ ] PCI DSS compliance (Razorpay handles this)

**Security Audit Status**: ⏳ Pending / ✅ Completed

---

### Step 5.6: Performance Testing

Test application performance under load:

- [ ] Multiple concurrent users
- [ ] Database query optimization
- [ ] API response times acceptable
- [ ] Payment gateway response handling
- [ ] Timeout handling implemented

**Performance Test Results**:

- Checkout page load time: **\_** seconds
- Payment processing time: **\_** seconds
- Webhook processing time: **\_** seconds

**Performance Status**: ⏳ Pending / ✅ Acceptable / ❌ Needs Optimization

---

## Phase 6: Go Live

### Step 6.1: Pre-Launch Checklist

Final checks before production deployment:

- [ ] **KYC Status**: ✅ Approved
- [ ] **Live API Keys**: ✅ Generated and configured
- [ ] **Webhook**: ✅ Configured and tested
- [ ] **Staging Tests**: ✅ All tests passed
- [ ] **Security Audit**: ✅ Completed
- [ ] **Performance**: ✅ Acceptable
- [ ] **Documentation**: ✅ Complete
- [ ] **Team Training**: ✅ Team knows how to handle payments
- [ ] **Support Ready**: ✅ Support processes in place

**Pre-Launch Status**: ⏳ Pending / ✅ Ready for Launch / ❌ Issues to Resolve

---

### Step 6.2: Deploy to Production

- [ ] Create production deployment plan
- [ ] Schedule deployment (prefer low-traffic time)
- [ ] Take backup of production database
- [ ] Deploy code to production
- [ ] Update production environment variables with live keys
- [ ] Verify application starts successfully
- [ ] Check no errors in production logs
- [ ] Test production URL accessibility

**Production Deployment**:

- Deployment Date: ******\_\_\_******
- Deployment Time: ******\_\_\_******
- Production URL: ******\_\_\_******

**Status**: ⏳ Pending / ✅ Completed

---

### Step 6.3: Post-Launch Verification

Immediately after deployment:

- [ ] **Smoke Test**
  - [ ] Homepage loads correctly
  - [ ] Checkout page accessible
  - [ ] Product pages functional

- [ ] **First Live Transaction**
  - [ ] Process first real customer payment (if any)
  - [ ] Monitor payment flow closely
  - [ ] Verify webhook received
  - [ ] Check database updated correctly
  - [ ] Confirm customer notification sent

- [ ] **Monitor Systems**
  - [ ] Check application logs
  - [ ] Monitor error logs
  - [ ] Watch Razorpay Dashboard
  - [ ] Monitor webhook logs
  - [ ] Track database performance

- [ ] **Set Up Monitoring**
  - [ ] Error tracking (Sentry, etc.)
  - [ ] Payment monitoring alerts
  - [ ] Webhook failure alerts
  - [ ] Daily transaction reports

**Post-Launch Status**: ⏳ Pending / ✅ Completed

---

### Step 6.4: Monitor First Week

During the first week of live operations:

- [ ] **Daily Checks**:
  - [ ] Review all transactions in Razorpay Dashboard
  - [ ] Check for failed payments (investigate causes)
  - [ ] Verify webhook processing
  - [ ] Monitor customer support tickets
  - [ ] Review settlement reports

- [ ] **Weekly Review**:
  - [ ] Total transactions processed: **\_**
  - [ ] Success rate: **\_**%
  - [ ] Failed payments: **\_**
  - [ ] Refunds processed: **\_**
  - [ ] Issues identified: **\_**

**First Week Status**: ⏳ Ongoing / ✅ Completed

---

### Step 6.5: Ongoing Maintenance

Set up processes for ongoing maintenance:

- [ ] **Regular Monitoring**
  - [ ] Daily transaction review
  - [ ] Weekly settlement reconciliation
  - [ ] Monthly financial reports

- [ ] **Compliance**
  - [ ] Keep KYC documents updated
  - [ ] Renew licenses before expiry
  - [ ] Update business information if changed
  - [ ] Maintain audit trail

- [ ] **Security**
  - [ ] Rotate API keys periodically (every 6 months)
  - [ ] Review webhook logs for anomalies
  - [ ] Keep dependencies updated
  - [ ] Regular security audits

- [ ] **Support**
  - [ ] Handle customer payment queries promptly
  - [ ] Process refunds as per policy
  - [ ] Respond to chargebacks/disputes
  - [ ] Maintain support documentation

**Maintenance Process Status**: ⏳ Pending / ✅ Established

---

## Troubleshooting

### KYC Rejection Reasons & Solutions

| Issue                        | Reason                                      | Solution                                          |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------- |
| **Documents Unclear**        | Blurry, pixelated, or dark images           | Rescan with better resolution and lighting        |
| **Name Mismatch**            | Variation in business name across documents | Use exact same name as per registration           |
| **Wrong Business Type**      | Selected type doesn't match registration    | Select correct business type                      |
| **Missing Documents**        | Required documents not uploaded             | Upload all mandatory documents                    |
| **Expired Documents**        | ID proof or licenses expired                | Renew documents and reupload                      |
| **Unauthorized Signatory**   | Signatory not director/partner              | Use authorized person with legal authority        |
| **Bank Account Mismatch**    | Account not in business name                | Open account in business name or use correct type |
| **Incomplete Registration**  | Business registration incomplete            | Complete registration process                     |
| **Industry License Missing** | Required industry license not provided      | Obtain and upload industry license                |

---

### Common Integration Issues

#### Issue: Payment not processing

**Symptoms**: User clicks pay, but nothing happens

**Solutions**:

- [ ] Check API key is correct (live key for production)
- [ ] Verify key is loaded from environment variables
- [ ] Check network requests in browser DevTools
- [ ] Review server-side error logs
- [ ] Verify Razorpay script loaded correctly

---

#### Issue: Webhook not received

**Symptoms**: Payment successful but order not created

**Solutions**:

- [ ] Check webhook URL is accessible publicly
- [ ] Verify webhook endpoint not behind authentication
- [ ] Check firewall/security settings
- [ ] Review webhook logs in Razorpay Dashboard
- [ ] Test webhook endpoint with test payload
- [ ] Verify signature validation logic

---

#### Issue: Payment successful but amount incorrect

**Symptoms**: Wrong amount charged to customer

**Solutions**:

- [ ] Verify amount calculation logic server-side
- [ ] Never trust client-side amount
- [ ] Add server-side validation
- [ ] Check for race conditions in amount updates

---

#### Issue: Settlements not received

**Symptoms**: Payments successful but money not in bank

**Solutions**:

- [ ] Check settlement schedule in Razorpay Dashboard
- [ ] Verify bank account details correct
- [ ] Review settlement reports
- [ ] Check for holds or pending verification
- [ ] Contact Razorpay support if delayed beyond schedule

---

### Support Contacts

| Issue Type                | Contact Method                                 |
| ------------------------- | ---------------------------------------------- |
| **KYC Issues**            | Dashboard → Support → KYC                      |
| **Technical Integration** | [razorpay.com/docs](https://razorpay.com/docs) |
| **Payment Issues**        | Dashboard → Support → Payments                 |
| **Settlement Issues**     | Dashboard → Support → Settlements              |
| **General Support**       | support@razorpay.com                           |
| **Phone Support**         | 1800-1200-4600 (India)                         |

---

## Completion Summary

### Overall Progress

- [ ] **Phase 1**: Account Creation - ⏳ Pending / ✅ Completed
- [ ] **Phase 2**: Document Preparation - ⏳ Pending / ✅ Completed
- [ ] **Phase 3**: KYC Submission - ⏳ Pending / ✅ Completed
- [ ] **Phase 4**: Post-Approval Setup - ⏳ Pending / ✅ Completed
- [ ] **Phase 5**: Integration & Testing - ⏳ Pending / ✅ Completed
- [ ] **Phase 6**: Go Live - ⏳ Pending / ✅ Completed

### Final Status

- **KYC Status**: ⏳ Pending / ✅ Approved / ❌ Rejected
- **Live Keys Generated**: ⏳ Pending / ✅ Yes
- **Integration Complete**: ⏳ Pending / ✅ Yes
- **Production Deployment**: ⏳ Pending / ✅ Live

### Congratulations! 🎉

If all phases are completed, you have successfully:

- ✅ Completed Razorpay KYC
- ✅ Generated live API keys
- ✅ Integrated payment gateway
- ✅ Deployed to production
- ✅ Ready to accept real payments

---

## Related Documents

- [RAZORPAY_KYC_OVERVIEW.md](./RAZORPAY_KYC_OVERVIEW.md) - General KYC overview
- [BUSINESS_TYPES_REQUIREMENTS.md](./BUSINESS_TYPES_REQUIREMENTS.md) - Business type requirements
- [INDUSTRY_CERTIFICATIONS.md](./INDUSTRY_CERTIFICATIONS.md) - Industry certifications

---

## Document Control

**Version**: 1.0
**Last Updated**: 2025-11-06
**Author**: Development Team
**Status**: Draft / Final

**Change Log**:
| Date | Version | Changes | Author |
|------|---------|---------|--------|
| 2025-11-06 | 1.0 | Initial checklist created | Development Team |

---

**Notes**:

- Keep this checklist updated as you progress
- Mark items as completed with dates
- Document any deviations or issues
- Use as reference for future KYC processes
