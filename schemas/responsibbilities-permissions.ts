import { z } from "zod";

export const ResponsibilitiesAndPermissionsSchema = z.object({
  departments: z.record(
    z.object({
      positions: z.record(
        z.object({
          responsibilities: z.record(z.array(z.string())),
          permissions: z.record(z.array(z.string())),
        }),
      ),
    }),
  ),
});

export type TResponsibilitiesAndPermissions = z.infer<
  typeof ResponsibilitiesAndPermissionsSchema
>;

export const responsibilitiesAndPermissions: TResponsibilitiesAndPermissions = {
  departments: {
    Management: {
      positions: {
        Admin: {
          responsibilities: {
            "User Management": [
              "Manage user roles and permissions",
              "Approve or reject user-generated content",
            ],
            "System Management": [
              "Oversee platform security and compliance",
              "Monitor system performance and uptime",
              "Maintain and update platform configurations",
            ],
            "Financial Management": [
              "Manage billing and subscription plans",
              "Review financial reports and projections",
            ],
            Reporting: [
              "Generate and review system reports",
              "Audit platform activities for compliance",
            ],
          },
          permissions: {
            "User Access": ["full_access", "manage_users"],
            "System Access": [
              "configure_system",
              "view_logs",
              "access_sensitive_data",
            ],
            "Financial Access": ["manage_billing", "view_financial_reports"],
            "Reporting Access": ["view_reports", "export_data"],
          },
        },
      },
    },
    Engineering: {
      positions: {
        Developer: {
          responsibilities: {
            Development: [
              "Implement new features and functionality",
              "Fix bugs and perform code reviews",
            ],
            Maintenance: [
              "Maintain codebase and ensure scalability",
              "Monitor and optimize system performance",
            ],
            Collaboration: [
              "Collaborate with the product team to refine requirements",
              "Provide technical guidance to the support team",
            ],
            Deployment: [
              "Deploy updates and manage CI/CD pipelines",
              "Ensure smooth and timely rollouts of features",
            ],
          },
          permissions: {
            "Code Access": [
              "access_codebase",
              "commit_code",
              "manage_branches",
            ],
            "Deployment Access": ["manage_deployments", "rollback_deployments"],
            "Monitoring Access": ["view_logs", "access_performance_metrics"],
            "Integration Access": ["manage_integration", "configure_apis"],
          },
        },
      },
    },
    Product: {
      positions: {
        "Product Manager": {
          responsibilities: {
            "Product Strategy": [
              "Define product roadmap and prioritize features",
              "Analyze user feedback and metrics to improve the product",
            ],
            "Stakeholder Engagement": [
              "Collaborate with stakeholders to gather requirements",
              "Communicate product vision to the team",
            ],
            Documentation: [
              "Create and manage product specifications",
              "Maintain product documentation and user guides",
            ],
            "Market Research": [
              "Monitor market trends and competitor offerings",
              "Identify opportunities for product enhancements",
            ],
          },
          permissions: {
            "Roadmap Access": ["view_roadmap", "manage_features"],
            "User Feedback Access": [
              "access_user_feedback",
              "analyze_feedback",
            ],
            "Reporting Access": ["view_reports", "generate_product_reports"],
            "Collaboration Access": [
              "collaborate_with_teams",
              "view_internal_documents",
            ],
          },
        },
      },
    },
    Support: {
      positions: {
        "Customer Support": {
          responsibilities: {
            "Customer Assistance": [
              "Assist users with issues and inquiries",
              "Provide onboarding and training for new customers",
            ],
            "Issue Resolution": [
              "Escalate technical issues to the development team",
              "Resolve common technical problems",
            ],
            Documentation: [
              "Maintain knowledge base and help documentation",
              "Update FAQs and support content regularly",
            ],
            "Customer Satisfaction": [
              "Monitor and respond to customer feedback",
              "Ensure customer satisfaction and retention",
            ],
          },
          permissions: {
            "Customer Data Access": [
              "view_customer_data",
              "edit_customer_profiles",
            ],
            "Support Access": ["respond_to_tickets", "manage_help_center"],
            "Feedback Access": ["access_user_feedback", "log_feedback"],
            "Basic Reporting Access": [
              "view_basic_reports",
              "generate_support_reports",
            ],
          },
        },
      },
    },
    Marketing: {
      positions: {
        Marketing: {
          responsibilities: {
            "Campaign Management": [
              "Create and execute marketing campaigns",
              "Manage partnerships and affiliate programs",
            ],
            "Content Creation": [
              "Develop content for blogs, newsletters, and ads",
              "Manage social media accounts and online presence",
            ],
            "Analysis and Reporting": [
              "Monitor and analyze marketing metrics",
              "Report on campaign effectiveness",
            ],
            Collaboration: [
              "Collaborate with the product team for feature launches",
              "Work with design teams to create marketing materials",
            ],
          },
          permissions: {
            "Marketing Tools Access": [
              "access_marketing_tools",
              "manage_campaigns",
            ],
            "Content Access": ["create_content", "schedule_posts"],
            "Social Media Access": [
              "manage_social_media",
              "respond_to_social_media_engagements",
            ],
            "Reporting Access": ["view_reports", "generate_marketing_reports"],
          },
        },
      },
    },
    Customer: {
      positions: {
        Customer: {
          responsibilities: {
            "Platform Usage": [
              "Use the platform services as intended",
              "Manage personal account settings and data",
            ],
            Feedback: [
              "Provide feedback and report issues",
              "Engage with the community and participate in discussions",
            ],
            Compliance: [
              "Adhere to terms of service and usage policies",
              "Ensure the privacy of personal data",
            ],
            Billing: [
              "Make payments for subscription plans",
              "Manage billing information and preferences",
            ],
          },
          permissions: {
            "Account Access": ["access_personal_account", "update_profile"],
            "Service Access": ["use_platform_features", "view_own_data"],
            "Billing Access": ["make_payments", "update_billing_info"],
            "Community Access": [
              "participate_in_community",
              "join_discussions",
            ],
          },
        },
      },
    },
  },
};
