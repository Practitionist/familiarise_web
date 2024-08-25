"use client";
import { zodResolver } from '@hookform/resolvers/zod';
import { useSession } from 'next-auth/react';
import React, { useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';

import { ClassPlan, ConsultantPlans, consultantPlansSchema, ConsultationPlan, SubscriptionPlan, WebinarPlan } from '@/schemas/PlanSchema';
import ClassPlanForm from './components/ClassPlanForm';
import ConsultationPlanForm from './components/ConsultationPlanForm';
import SubscriptionPlanForm from './components/SubscriptionPlanForm';
import ProgressIndicator from './components/ui/ProgressIndicator';
import WebinarPlanForm from './components/WebinarPlanForm';

const ConsultantPlansForm: React.FC = () => {
  const { data: session } = useSession();
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<Partial<ConsultantPlans>>({});

  const methods = useForm<ConsultantPlans>({
    resolver: zodResolver(consultantPlansSchema),
    defaultValues: formData,
  });

  const handleNext = async (stepData: Partial<ConsultantPlans>) => {
    console.log('handleNext called with data:', stepData);
    setFormData(prevData => ({ ...prevData, ...stepData }));
    setStep(prevStep => prevStep + 1);
  };

  const handleBack = () => setStep(prevStep => prevStep - 1);

  const handleSubmit = async (data: ConsultantPlans) => {
    const finalData = { ...formData, ...data };
    console.log('Final Submitted Data:', finalData);

    try {
      const id = session?.user?.id;
      if (!id) {
        throw new Error('User ID not found');
      }

      const response = await fetch(`/api/form/consultant/plans/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(finalData),
      });

      if (!response.ok) {
        throw new Error('Failed to update consultant plans');
      }

      const result = await response.json();
      console.log('Consultant plans update successful:', result);
      // Handle successful update (e.g., show success message, redirect)
    } catch (error) {
      console.error('Error updating consultant plans:', error);
      // Handle error (e.g., show error message)
    }
  };

  const renderFormStep = () => {
    switch (step) {
      case 0:
        return (
          <ConsultationPlanForm
            onNext={async (plans) => await handleNext({ consultationPlans: plans as ConsultationPlan[] })}
            onBack={handleBack}
            initialData={formData.consultationPlans as ConsultationPlan[] || []}
          />
        );
      case 1:
        return (
          <SubscriptionPlanForm
            onNext={async (plans) => await handleNext({ subscriptionPlans: plans as SubscriptionPlan[] })}
            onBack={handleBack}
            initialData={formData.subscriptionPlans as SubscriptionPlan[] || []}
          />
        );
      case 2:
        return (
          <WebinarPlanForm
            onNext={async (plans) => await handleNext({ webinarPlans: plans as WebinarPlan[] })}
            onBack={handleBack}
            initialData={formData.webinarPlans as WebinarPlan[] || []}
          />
        );
      case 3:
        return (
          <ClassPlanForm
            onSubmit={async (plans) => await handleSubmit({ ...formData, classPlans: plans as ClassPlan[] } as ConsultantPlans)}
            onBack={handleBack}
            initialData={formData.classPlans as ClassPlan[] || []}
          />
        );
      default:
        return null;
    }
  };

  return (
    <FormProvider {...methods}>
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50">
        <h1 className="text-2xl font-bold mb-6">Consultant Plans</h1>
        <ProgressIndicator currentStep={step} totalSteps={4} />
        {renderFormStep()}
      </div>
    </FormProvider>
  );
};

export default function ConsultantPlansPage() {
  return (
    <div className="container mx-auto px-4 py-8">
      <ConsultantPlansForm />
    </div>
  );
}