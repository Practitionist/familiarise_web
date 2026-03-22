# Competitor International Payment Analysis

> **Research Date:** March 2026

---

## 1. TopMate.io (Direct Competitor -- India)

| Aspect                   | Details                                    |
| ------------------------ | ------------------------------------------ |
| **Payment gateways**     | Razorpay (India) + Stripe (international)  |
| **Commission**           | 7% (Basic) / 10% (Premium)                |
| **Inbound international**| Accept via Stripe, settle in INR           |
| **Outbound payouts**     | Bank (India/USA) + PayPal (100+ countries) |
| **Effective intl fee**   | 16-18% (commission + gateway + forex)      |
| **GST/TDS handling**     | None -- creator's responsibility            |
| **PA-CB compliance**     | Questionable (no public mention)           |

**Weaknesses:**
- PayPal-only for non-India/US payouts (expensive)
- Hidden forex markups not disclosed to creators
- Withdrawal reliability issues (Trustpilot complaints)
- No tax compliance infrastructure

---

## 2. Preplaced.in (Direct Competitor -- India)

| Aspect                   | Details                                    |
| ------------------------ | ------------------------------------------ |
| **Payment gateways**     | Razorpay (likely, based on India focus)     |
| **Commission**           | Not publicly disclosed                     |
| **Target market**        | India-focused (career mentorship)          |
| **International support**| Limited -- primarily India mentors/mentees  |
| **Payout method**        | Not publicly documented                    |

**Key insight:** Preplaced appears to be India-only for both mentors and mentees. They have not publicly documented international payment support, which aligns with their "mentorship till placement" model focused on Indian job market.

---

## 3. Maven.com (International Competitor -- US)

| Aspect                   | Details                                    |
| ------------------------ | ------------------------------------------ |
| **Payment gateways**     | Stripe only                                |
| **Commission**           | 10% of course revenue                      |
| **Instructor share**     | 90% minus Stripe fees                      |
| **Inbound payments**     | Stripe (USD, EUR, GBP, etc.)               |
| **Outbound payouts**     | Stripe Connect to instructor's local bank  |
| **Countries supported**  | All Stripe Connect countries (~47)         |
| **Stripe fees**          | 2.9% + $0.30 (varies by country)           |
| **EU VAT**               | Maven collects and remits on behalf of instructors |
| **Tax handling (US)**    | Issues 1099-NEC if >$600/year              |
| **Tax handling (intl)**  | Instructor's responsibility                |

**Strengths to learn from:**
- Stripe Connect handles all international complexity
- EU VAT auto-collection is a differentiator
- Simple 90/10 split is easy to understand
- Instructor payout schedule configurable via Stripe

**Limitations:**
- Only available in Stripe Connect countries
- No Razorpay/UPI for Indian students
- No alternative payout methods

---

## 4. Calendly (Scheduling + Payments -- US)

| Aspect                   | Details                                    |
| ------------------------ | ------------------------------------------ |
| **Payment integrations** | Stripe + PayPal                            |
| **Commission**           | 0% (Calendly doesn't take payment commission) |
| **Currencies supported** | USD, AUD, CAD, EUR, GBP (Stripe); 5 currencies (PayPal) |
| **Tax handling**         | NONE -- does not calculate/collect VAT or sales tax |
| **Payout**               | Direct to user's Stripe/PayPal account     |
| **Model**                | SaaS subscription ($12-16/mo) not commission |

**Key insight:** Calendly avoids the marketplace/intermediary classification entirely by charging a SaaS fee, not commission. They explicitly state they don't handle tax. Users manage their own Stripe/PayPal accounts directly.

---

## 5. Superpeer (Expert Calls -- US)

| Aspect                   | Details                                    |
| ------------------------ | ------------------------------------------ |
| **Payment gateway**      | Stripe                                     |
| **Model**                | Platform for paid 1:1 video consultations  |
| **Features**             | Customizable booking, integrated payments  |
| **Calendar sync**        | Yes                                        |
| **Video**                | Built-in (like Familiarise)                |

**Limited public info on payment specifics.** Superpeer appears to use Stripe Connect similarly to Maven.

---

## 6. Mentorcam (Celebrity Mentorship -- US)

| Aspect                   | Details                                    |
| ------------------------ | ------------------------------------------ |
| **Funding**              | $1.57M seed (San Francisco)                |
| **Founded**              | 2019                                       |
| **Focus**                | 1:1 mentorship with celebrities/experts    |
| **Payment**              | Not publicly documented in detail          |

**Limited public payment infrastructure data available.**

---

## 7. Comparison Matrix

| Feature                  | TopMate | Preplaced | Maven  | Calendly | Superpeer | Familiarise (Target) |
| ------------------------ | ------- | --------- | ------ | -------- | --------- | -------------------- |
| Accept intl payments     | Yes     | Limited   | Yes    | Yes      | Yes       | Yes (Razorpay)       |
| Payout to intl creators  | PayPal  | No        | Stripe | N/A      | Stripe    | TBD (Wise/PayPal)    |
| Multi-currency pricing   | No      | No        | Yes    | Limited  | Unknown   | Planned              |
| Tax handling              | No      | No        | Partial| No       | Unknown   | Planned              |
| PA-CB compliant gateway  | Unclear | N/A       | N/A    | N/A      | N/A       | Yes (Razorpay)       |
| EU VAT collection        | No      | No        | Yes    | No       | Unknown   | Future               |
| Commission rate          | 7-10%   | Unknown   | 10%    | 0%       | Unknown   | 10% (launch)         |
| Effective intl fee       | 16-18%  | N/A       | 13-14% | N/A      | Unknown   | Target: <15%         |

---

## 8. Strategic Takeaways

### What Competitors Get Right
1. **Maven:** Stripe Connect handles everything -- simplest approach for multi-country payouts
2. **Calendly:** Avoids marketplace complexity entirely with SaaS model
3. **TopMate:** Has scale (300K+ creators) despite suboptimal payment infrastructure

### What Competitors Get Wrong
1. **TopMate:** Hidden fees, unreliable payouts, no tax compliance
2. **Preplaced:** No international support at all
3. **All Indian competitors:** No EU VAT handling, limited payout options

### Familiarise Opportunity
1. **Better transparency:** Show total fee breakdown before checkout
2. **Reliable payouts:** Guarantee payout SLAs (2-day for India, 5-day international)
3. **Tax compliance built-in:** Auto-generate GST invoices, handle TCS
4. **Wider payout options:** Bank (India) + Wise API (international) + PayPal (fallback)
5. **PA-CB compliant:** Via Razorpay (licensed Dec 2025)

---

## Sources

- [TopMate Payouts](https://topmate72420835211887570.freshdesk.com/support/solutions/articles/1070000111278-payouts)
- [TopMate Pricing](https://topmate.io/pricing)
- [Maven Getting Paid](https://help.maven.com/en/articles/5593804-getting-paid)
- [Maven Instructor Policy](https://help.maven.com/en/articles/12240853-maven-instructor-policy-guidebook)
- [Maven Course Income Taxes](https://help.maven.com/en/articles/5871627-your-course-income-taxes-us-based-instructors)
- [Calendly Stripe Integration](https://calendly.com/integration/stripe)
- [Calendly PayPal Integration](https://calendly.com/blog/paypal-integration)
- [Calendly Payments Features](https://calendly.com/features/payments)
- [Preplaced Website](https://www.preplaced.in/)
- [Superpeer Platform (SaasBM)](https://saasbm.com/expert-video-calls-knowledge-sharing-platform/)
- [Mentorcam Crunchbase](https://www.crunchbase.com/organization/mentorcam)
