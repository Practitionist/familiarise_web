import React from 'react';

const ProgressIndicator: React.FC<{ currentStep: number; totalSteps: number }> = ({ currentStep, totalSteps }) => (
  <div className="flex items-center space-x-4 mb-8">
    {Array.from({ length: totalSteps }, (_, i) => (
      <React.Fragment key={i}>
        <div
          className={`w-8 h-8 rounded-full flex items-center justify-center ${
            i <= currentStep ? 'bg-primary text-white' : 'bg-gray-200 text-gray-500'
          }`}
        >
          {i + 1}
        </div>
        {i < totalSteps - 1 && <div className="w-8 h-0.5 bg-gray-300" />}
      </React.Fragment>
    ))}
  </div>
);

export default ProgressIndicator;