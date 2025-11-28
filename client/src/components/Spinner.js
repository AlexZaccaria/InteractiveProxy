import React from 'react';

function Spinner({ size = 'md', className = '' }) {
  const sizeMap = {
    sm: { wrapper: 'w-6 h-6', ring: 'border-[2px]' },
    md: { wrapper: 'w-10 h-10', ring: 'border-[2px]' },
    lg: { wrapper: 'w-14 h-14', ring: 'border-[3px]' },
    xl: { wrapper: 'w-20 h-20', ring: 'border-[3px]' }
  };

  const sizes = sizeMap[size] || sizeMap.md;

  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div className={`relative ${sizes.wrapper}`}>
        {/* Base ring */}
        <div
          className={`absolute inset-0 rounded-full ${sizes.ring} border-slate-800/80`}
        />

        {/* Animated arc */}
        <div
          className={`absolute inset-0 rounded-full ${sizes.ring} border-transparent border-t-blue-500 border-r-purple-500 animate-spin`}
          style={{ animationDuration: '1.1s' }}
        />

        <div
          className={`absolute inset-[3px] rounded-full ${sizes.ring} border-transparent border-b-cyan-400 border-l-blue-500 animate-spin`}
          style={{ animationDuration: '0.85s' }}
        />

        {/* Soft inner glow */}
        <div className="absolute inset-[6px] rounded-full bg-[#050509] shadow-[0_0_20px_rgba(59,130,246,0.4)]" />
      </div>
    </div>
  );
}

export default Spinner;
